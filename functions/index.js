// Tier 3 AI generation proxy — see CLAUDE.md "AI generation model".
//
// Holds the Gemini API key server-side (Cloud Secret Manager, via defineSecret — never sent to or
// embedded in the client) and forwards a prompt built by the client (buildAiInstruction() /
// buildRoutesInstruction() in index.html — the exact same instruction text Tier 2's copy-paste flow
// already builds) to the Gemini API, returning the raw text response. The client feeds that text
// into the exact same validate/preview pipeline the paste-back flow already uses — this function's
// only job is "run the prompt and hand back the text," not anything schema-aware.
//
// A callable function (onCall) rather than a plain HTTPS endpoint: the Firebase client SDK attaches
// the caller's ID token automatically, and the SDK verifies it before this code ever runs — so
// request.auth is only ever populated for a genuinely signed-in Firebase user. That alone isn't
// enough, though: Firebase Auth lets ANY Google account sign in (see CLAUDE.md "Security model") —
// the allowlist is the real gate, normally enforced by firestore.rules, but a Cloud Function is a
// separate surface with no Firestore rule protecting it. So this function re-checks the caller's
// email against config/allowlist itself, mirroring what the rules already do for Firestore, rather
// than trusting "signed in" to mean "allowed."

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// Free-tier eligible as of this writing (see CLAUDE.md) — bump this if Google retires/renames it.
// Check https://ai.google.dev/gemini-api/docs/pricing for current free-tier model ids.
// Revised from gemini-2.5-flash-lite: retired for new users within days of this integration
// shipping — Google's own 404 response names the replacement directly
// ("models/gemini-2.5-flash-lite is no longer available to new users... use
// models/gemini-3.5-flash-lite"), so Gemini model ids apparently churn fast enough that this
// constant should be treated as something to actually check periodically, not "set once."
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

// Keep the whole project on one region rather than the default multi-region spread — no real
// latency requirement here, and pinning avoids surprising cross-region behavior later.
setGlobalOptions({ region: 'us-central1' });

// Models sometimes wrap JSON in a ```json ... ``` fence despite being told not to (the paste-back
// instruction text already asks for "no markdown, no code fences" — a human copying by hand can
// just delete it if a paste-back AI ignores that, but there's no human in this loop). Stripped
// defensively so the client's existing JSON.parse()-based validators don't have to special-case it.
function stripCodeFence(text){
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

exports.generateAiContent = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  if(!request.auth){
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const email = request.auth.token.email;
  if(!email){
    throw new HttpsError('permission-denied', 'This account has no email.');
  }

  const allowlistDoc = await db.collection('config').doc('allowlist').get();
  const emails = allowlistDoc.exists ? (allowlistDoc.data().emails || []) : [];
  if(!emails.includes(email)){
    throw new HttpsError('permission-denied', 'This account is not on the allowlist.');
  }

  const prompt = request.data?.prompt;
  if(typeof prompt !== 'string' || !prompt.trim()){
    throw new HttpsError('invalid-argument', 'Missing "prompt".');
  }
  // A generous cap, not a tight one — this is meant for the app's own generated instruction text
  // (place/route lists embedded in the prompt can get long for a big trip), not arbitrary input.
  if(prompt.length > 100000){
    throw new HttpsError('invalid-argument', 'Prompt too long.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY.value()}`;
  let res;
  try{
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
  }catch(err){
    throw new HttpsError('unavailable', `Could not reach the AI provider: ${err.message}`);
  }

  if(!res.ok){
    const body = await res.text().catch(()=>'');
    throw new HttpsError('internal', `AI provider request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  // finishReason other than STOP (e.g. SAFETY, MAX_TOKENS) means there's no usable full response —
  // surface that distinction rather than returning an empty/truncated string that would just fail
  // JSON.parse() downstream with no useful explanation.
  if(candidate?.finishReason && candidate.finishReason !== 'STOP'){
    throw new HttpsError('internal', `AI provider stopped early (${candidate.finishReason}) — try again, or narrow the request (e.g. fewer places per batch).`);
  }
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
  if(!text){
    throw new HttpsError('internal', 'AI provider returned no text.');
  }

  return { text: stripCodeFence(text) };
});
