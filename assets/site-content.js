(() => {
  // Applies admin-edited text (see admin-contenu.html) on top of the page's own
  // default HTML -- the default is always the fallback, this only ever overwrites
  // elements that carry a matching data-cms="key" attribute. No overrides = no
  // change, byte-for-byte identical to what's already on the page.
  fetch("/api/site-content", { signal: AbortSignal.timeout(5000) })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) return;
      const overrides = data.overrides || {};
      const touchedFaqKeys = new Set();

      for (const [key, value] of Object.entries(overrides)) {
        document.querySelectorAll(`[data-cms="${CSS.escape(key)}"]`).forEach((el) => {
          if (el.tagName === "META") {
            el.setAttribute("content", value);
          } else if (el.tagName === "TITLE") {
            el.textContent = value;
          } else if (el.hasAttribute("data-cms-html")) {
            el.innerHTML = value;
          } else {
            el.textContent = value;
          }
        });
        if (key.startsWith("home.faq.")) touchedFaqKeys.add(key);
      }

      // Keeps the FAQPage JSON-LD schema (search engines) in sync with the visible
      // FAQ text -- without this, editing a question/answer would desync the two
      // copies that exist today (visible <details> vs the <script id="faq-jsonld">
      // block), which is exactly the kind of drift a CMS is supposed to prevent.
      if (touchedFaqKeys.size) {
        const schema = document.getElementById("faq-jsonld");
        if (schema) {
          try {
            const json = JSON.parse(schema.textContent);
            const pairs = [
              ["home.faq.q1", "home.faq.a1"],
              ["home.faq.q2", "home.faq.a2"],
              ["home.faq.q3", "home.faq.a3"],
            ];
            pairs.forEach(([qKey, aKey], index) => {
              const entry = json.mainEntity?.[index];
              if (!entry) return;
              if (overrides[qKey]) entry.name = overrides[qKey];
              if (overrides[aKey]) entry.acceptedAnswer.text = overrides[aKey];
            });
            schema.textContent = JSON.stringify(json);
          } catch {
            // Malformed JSON-LD would be a pre-existing bug, not something to crash
            // page rendering over -- leave the schema untouched.
          }
        }
      }
    })
    .catch(() => {});
})();
