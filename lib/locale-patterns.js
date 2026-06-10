/**
 * lib/locale-patterns.js
 *
 * Per-locale post-submit pattern sets for non-English broker pages.
 *
 * English is NOT represented here: it is the always-on default baked into
 * lib/success.js and lib/confirm.js. These sets are unioned WITH English at
 * classification time, so a German page that happens to contain an English
 * phrase still matches.
 *
 * Each locale exposes three RegExp:
 *   - success: "request received / removed / done" verbatim copy
 *   - failure: "required field / invalid / error / try again" copy
 *   - confirm: "check your email / confirm the link" copy
 *
 * Patterns are deliberately conservative (mirrors the English tuning in
 * success.js): a false-positive success starts a 90-day cooldown that hides a
 * still-live data exposure, and a false-positive confirm freezes a real
 * success into a perpetual "pending" entry.
 *
 * Accents are matched literally; we do NOT strip diacritics, because page
 * innerText preserves them and stripping would broaden the match surface.
 */

// Spanish
const ES_SUCCESS = /(su (solicitud|petici[oó]n) (de (exclusi[oó]n|eliminaci[oó]n|baja))? ?(ha sido|fue|se ha) (recibida|procesada|completada|enviada|confirmada)|hemos recibido su (solicitud|petici[oó]n)|sus datos han sido (eliminados|borrados|suprimidos)|(solicitud|eliminaci[oó]n) (recibida|completada|procesada|enviada con [eé]xito)|enviad[oa] correctamente|baja (completada|confirmada))/i;
const ES_FAILURE = /(este campo es (obligatorio|requerido)|campo (obligatorio|requerido)|por favor (introduzca|complete|rellene|corrija)|(correo|email|tel[eé]fono|c[oó]digo postal|direcci[oó]n) (electr[oó]nico )?(no v[aá]lido|inv[aá]lido)|algo (sali[oó]|ha salido) mal|se (ha )?produjo un error|int[eé]ntelo de nuevo|no se pudo (procesar|enviar)|env[ií]o (fallido|err[oó]neo))/i;
const ES_CONFIRM = /(revise su (correo|bandeja de entrada|email)|confirme su (correo|email|solicitud)|verifique su (correo|email|solicitud)|le hemos enviado (un|una) (correo|email|enlace)|haga clic en el enlace|enlace de confirmaci[oó]n)/i;

// French
const FR_SUCCESS = /(votre demande (de (suppression|d[eé]sinscription|retrait))? ?(a [eé]t[eé]|est) ?(re[cç]ue|trait[eé]e|envoy[eé]e|enregistr[eé]e|confirm[eé]e|termin[eé]e)|nous avons (bien )?re[cç]u votre demande|vos donn[eé]es ont [eé]t[eé] (supprim[eé]es|effac[eé]es)|(demande|suppression) (re[cç]ue|trait[eé]e|envoy[eé]e avec succ[eè]s)|envoy[eé]e? avec succ[eè]s|d[eé]sinscription (r[eé]ussie|confirm[eé]e))/i;
const FR_FAILURE = /(ce champ est (obligatoire|requis)|champ (obligatoire|requis)|veuillez (saisir|compl[eé]ter|corriger)|(adresse e-?mail|courriel|t[eé]l[eé]phone|code postal|adresse) (invalide|non valide)|une erreur (s'est produite|est survenue)|quelque chose s'est mal pass[eé]|veuillez r[eé]essayer|impossible de (traiter|envoyer)|[eé]chec de l'envoi)/i;
const FR_CONFIRM = /(v[eé]rifie[rz] votre (e-?mail|bo[iî]te de r[eé]ception|courriel)|consultez votre (e-?mail|bo[iî]te)|confirmez votre (e-?mail|courriel|demande)|nous (vous )?avons envoy[eé] (un|une) (e-?mail|courriel|lien)|cliquez sur le lien|lien de confirmation)/i;

// German
const DE_SUCCESS = /(ihre? (anfrage|antrag|l[oö]schanfrage|abmeldung) (wurde|ist|ist erfolgreich) ?(eingegangen|erhalten|bearbeitet|gesendet|best[aä]tigt|abgeschlossen)|wir haben ihre (anfrage|anforderung) erhalten|ihre daten wurden (gel[oö]scht|entfernt)|(anfrage|l[oö]schung) (eingegangen|abgeschlossen|erfolgreich (gesendet|[uü]bermittelt))|erfolgreich (gesendet|[uü]bermittelt|abgemeldet))/i;
const DE_FAILURE = /(dieses feld ist (erforderlich|ein pflichtfeld)|pflichtfeld|bitte (geben sie|f[uü]llen sie|korrigieren sie)|(ung[uü]ltige|ung[uü]ltiges) (e-?mail|telefon|postleitzahl|adresse)|etwas ist schief ?(gelaufen|gegangen)|ein fehler ist (aufgetreten|passiert)|bitte versuchen sie es erneut|konnte nicht (verarbeitet|gesendet) werden|[uü]bermittlung fehlgeschlagen)/i;
const DE_CONFIRM = /([uü]berpr[uü]fen sie ihre? (e-?mail|posteingang)|pr[uü]fen sie ihr postfach|best[aä]tigen sie ihre? (e-?mail|anfrage)|verifizieren sie ihre? (e-?mail|anfrage)|wir haben ihnen (eine|einen) (e-?mail|link) (gesendet|geschickt)|klicken sie auf den link|best[aä]tigungslink)/i;

// Portuguese
const PT_SUCCESS = /(sua (solicita[cç][aã]o|pedido) (de (exclus[aã]o|remo[cç][aã]o|cancelamento))? ?(foi|est[aá]|foi recebid[oa]) ?(recebid[oa]|processad[oa]|enviad[oa]|conclu[ií]d[oa]|confirmad[oa])|recebemos sua (solicita[cç][aã]o|pedido)|seus dados foram (exclu[ií]dos|removidos|apagados)|(solicita[cç][aã]o|remo[cç][aã]o) (recebid[oa]|conclu[ií]d[oa]|enviad[oa] com sucesso)|enviad[oa] com sucesso|cancelamento (conclu[ií]do|confirmado))/i;
const PT_FAILURE = /(este campo [eé] obrigat[oó]rio|campo obrigat[oó]rio|por favor (insira|preencha|complete|corrija)|(e-?mail|telefone|c[oó]digo postal|cep|endere[cç]o) (inv[aá]lido|n[aã]o v[aá]lido)|algo deu errado|ocorreu um erro|tente novamente|n[aã]o foi poss[ií]vel (processar|enviar)|falha no envio)/i;
const PT_CONFIRM = /(verifique (o )?seu (e-?mail|caixa de entrada)|confirme (o )?seu (e-?mail|solicita[cç][aã]o|pedido)|enviamos (um|uma) (e-?mail|link) para voc[eê]|clique no link|link de confirma[cç][aã]o)/i;

// Italian
const IT_SUCCESS = /(la tua richiesta (di (cancellazione|rimozione|disiscrizione))? ?([eè] stata|[eè]) ?(ricevuta|elaborata|inviata|completata|confermata)|abbiamo ricevuto la tua richiesta|i tuoi dati sono stati (eliminati|rimossi|cancellati)|(richiesta|rimozione) (ricevuta|completata|inviata con successo)|inviat[ao] con successo|disiscrizione (completata|confermata))/i;
const IT_FAILURE = /(questo campo [eè] obbligatorio|campo obbligatorio|(per favore|si prega di) (inserisci|inserire|compila|completa|correggi)|(e-?mail|telefono|codice postale|cap|indirizzo) (non valido|invalido)|qualcosa [eè] andato storto|si [eè] verificato un errore|riprova(re)?|impossibile (elaborare|inviare)|invio non riuscito)/i;
const IT_CONFIRM = /(controlla la tua (e-?mail|casella di posta)|verifica la tua (e-?mail|posta)|conferma (la tua )?(e-?mail|richiesta)|ti abbiamo inviato (un|una) (e-?mail|link)|clicca sul link|link di conferma)/i;

const LOCALE_PATTERNS = {
  es: { success: ES_SUCCESS, failure: ES_FAILURE, confirm: ES_CONFIRM },
  fr: { success: FR_SUCCESS, failure: FR_FAILURE, confirm: FR_CONFIRM },
  de: { success: DE_SUCCESS, failure: DE_FAILURE, confirm: DE_CONFIRM },
  pt: { success: PT_SUCCESS, failure: PT_FAILURE, confirm: PT_CONFIRM },
  it: { success: IT_SUCCESS, failure: IT_FAILURE, confirm: IT_CONFIRM },
};

const SUPPORTED_LANGS = Object.keys(LOCALE_PATTERNS);

/**
 * Normalize a raw <html lang> attribute value to a bare two-letter lowercase
 * ISO code. 'es-ES' -> 'es', 'PT-br' -> 'pt', 'it_IT' -> 'it'. Returns '' for
 * missing / non-string input.
 *
 * @param {string|null|undefined} htmlLang
 * @returns {string}
 */
function langOf(htmlLang) {
  if (!htmlLang || typeof htmlLang !== 'string') return '';
  return htmlLang.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * Return the locale pattern set for a language code, or null when the language
 * is English / unknown / missing (English is handled by the default patterns).
 * Accepts un-normalized region tags (e.g. 'es-MX').
 *
 * @param {string|null|undefined} lang
 * @returns {{ success: RegExp, failure: RegExp, confirm: RegExp }|null}
 */
function patternsFor(lang) {
  const code = langOf(lang);
  return LOCALE_PATTERNS[code] || null;
}

module.exports = { langOf, patternsFor, SUPPORTED_LANGS, LOCALE_PATTERNS };
