// Generic tab switcher, shared by dashboard.html and admin-contenu.html -- both
// used to be one long scroll through every section at once. Panels are hidden via
// the `hidden` attribute, never removed from the DOM, so every existing
// data-attribute selector the rest of each page's scripts already rely on
// (auth.js, premium-admin.js, admin-content.js) keeps working exactly as before,
// completely unaware tabs exist -- switching tabs is pure client-side visibility,
// never a navigation, never a reload.
(() => {
  let tabGroupIdCounter = 0;
  document.querySelectorAll("[data-tabs]").forEach(initTabs);

  function initTabs(root) {
    const buttons = [...root.querySelectorAll("[data-tab-btn]")];
    const panels = [...root.querySelectorAll("[data-tab-panel]")];
    if (!buttons.length || !panels.length) return;
    const tabGroupId = "oracle-tab-group-" + (++tabGroupIdCounter);
    buttons.forEach((button) => {
      const key = button.dataset.tabBtn;
      const tabId = tabGroupId + "-tab-" + key;
      const panelId = tabGroupId + "-panel-" + key;
      button.id = tabId;
      button.setAttribute("aria-controls", panelId);
      const panel = panels.find((candidate) => candidate.dataset.tabPanel === key);
      if (panel) {
        panel.id = panelId;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tabId);
        panel.setAttribute("tabindex", "0");
      }
    });

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
      button.addEventListener("keydown", (event) => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = buttons.indexOf(button);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[nextIndex].focus();
        activate(buttons[nextIndex].dataset.tabBtn);
      });
    });

    activate(buttons[0]?.dataset.tabBtn);
  }
})();
