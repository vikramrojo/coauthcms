/**
 * The admin's own files, served by the admin itself at `<mount>/assets/`, so a
 * host copies nothing. The style is the entry form's layout and nothing else
 * (Largen styles the rest); the script is under 5 KB and loads the markdown
 * editor only on a page that has a markdown field.
 */

export const ADMIN_CSS = `@layer largen.components {
  .fields { display: grid; grid-template-columns: minmax(7rem, 12rem) minmax(0, 1fr); gap: 0.75rem 1rem; margin: 0; }
  .fields > dt { padding-block-start: 0.5em; font-weight: 600; }
  .fields > dd { margin: 0; min-inline-size: 0; }
  .fields pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .fields textarea { min-block-size: 6rem; }
  .fields .milkdown { border: 1px solid var(--line); border-radius: var(--radius-sm); }
  @media (max-width: 40rem) { .fields { grid-template-columns: 1fr; } .fields > dt { padding-block-start: 0; } }
}
`;

/**
 * Three things, all optional: Largen's dark theme answers to `data-theme="dark"`, which this sets from the system's
 * preference (the style sheet itself is linked only under that preference, and a policy without inline script cannot
 * set it in the page); a select marked `data-autosubmit` submits its form when changed (the filters), and a
 * `textarea[data-markdown]` gains the editor when the module named by `data-editor` loads. The text area stays in the
 * page, hidden only once the editor is up, and is written back from the editor when its form is submitted; if the
 * module fails to load, the text area is still the field.
 */
export const ADMIN_JS = `(function () {
  'use strict';
  var script = document.currentScript;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  function theme() { document.documentElement.setAttribute('data-theme', dark.matches ? 'dark' : 'light'); }
  theme();
  dark.addEventListener('change', theme);
  document.querySelectorAll('select[data-autosubmit]').forEach(function (select) {
    select.addEventListener('change', function () { select.form.requestSubmit(); });
  });
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-markdown]'));
  var url = script && script.getAttribute('data-editor');
  if (!areas.length || !url) return;
  import(url).then(function (editor) {
    areas.forEach(function (area) {
      var host = document.createElement('div');
      host.className = 'editor';
      area.after(host);
      editor.createEditor(host, area.value).then(function (instance) {
        area.style.display = 'none';
        area.form.addEventListener('submit', function () { area.value = instance.getMarkdown(); });
      }).catch(function () { host.remove(); });
    });
  }).catch(function () {});
})();
`;
