/* i18n.js — multi-language framework (lazy loads only the chosen language) */
window.I18N = window.I18N || {};
window.I18N.strings = window.I18N.strings || {};
window.I18N.langs = [{"code": "en", "name": "English", "native": "English"}, {"code": "hi", "name": "Hindi", "native": "हिन्दी"}, {"code": "bn", "name": "Bengali", "native": "বাংলা"}, {"code": "mr", "name": "Marathi", "native": "मराठी"}, {"code": "ta", "name": "Tamil", "native": "தமிழ்"}, {"code": "te", "name": "Telugu", "native": "తెలుగు"}, {"code": "gu", "name": "Gujarati", "native": "ગુજરાતી"}, {"code": "kn", "name": "Kannada", "native": "ಕನ್ನಡ"}, {"code": "ml", "name": "Malayalam", "native": "മലയാളം"}, {"code": "pa", "name": "Punjabi", "native": "ਪੰਜਾਬੀ"}, {"code": "or", "name": "Odia", "native": "ଓଡ଼ିଆ"}, {"code": "ur", "name": "Urdu", "native": "اردو"}];

window.CURRENT_LANG = localStorage.getItem('maasathi.lang') || 'en';

window.t = function (key) {
  var s = window.I18N.strings[window.CURRENT_LANG] || {};
  return s[key] || (window.I18N.strings.en || {})[key] || key;
};

/* load one language file, then run cb */
window.loadLang = function (code, cb) {
  if (window.I18N.strings[code]) { if (cb) cb(); return Promise.resolve(); }
  return new Promise(function (resolve) {
    var s = document.createElement('script');
    s.src = 'js/i18n/' + code + '.js';
    s.onload = function () { if (cb) cb(); resolve(); };
    s.onerror = function () { resolve(); };
    document.head.appendChild(s);
  });
};

/* set language, persist, reload translations into the page */
window.setLang = function (code) {
  window.CURRENT_LANG = code;
  localStorage.setItem('maasathi.lang', code);
  document.documentElement.lang = code;
  document.documentElement.dir = (code === 'ur') ? 'rtl' : 'ltr';
  return window.loadLang(code, function () {
    if (window.applyI18n) window.applyI18n();
    if (window.renderAll) window.renderAll();
    if (window.syncReminders) window.syncReminders();  // push messages bhi nayi bhasha mein
  });
};

/* apply to all elements with data-i18n / data-i18n-ph */
window.applyI18n = function () {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = window.t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
    el.setAttribute('placeholder', window.t(el.getAttribute('data-i18n-ph')));
  });
};
