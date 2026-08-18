// Generic tab switcher, shared by dashboard.html and admin-contenu.html -- both
// used to be one long scroll through every section at once. Panels are hidden via
// the `hidden` attribute, never removed from the DOM, so every existing
// data-attribute selector the rest of each page's scripts already rely on
// (auth.js, premium-admin.js, admin-content.js) keeps working exactly as before,
// completely unaware tabs exist -- switching tabs is pure client-side visibility,
// never a navigation, never a reload.
(() => {
  document.querySelectorAll("[data-tabs]").forEach(initTabs);

  function initTabs(root) {
    const buttons = [...root.querySelectorAll("[data-tab-btn]")];
    const panels = [...root.querySelectorAll("[data-tab-panel]")];
    if (!buttons.length || !panels.length) return;

    function activate(id) {
      const target = buttons.some((b) => b.dataset.tabBtn === id) ? id : buttons[0].dataset.tabBtn;
      buttons.forEach((b) => {
        const active = b.dataset.tabBtn === target;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((p) => { p.hidden = p.dataset.tabPanel !== target; });
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => activate(button.dataset.tabBtn));
    });

    activate(buttons[0]?.dataset.tabBtn);
  }
})();
