(() => {
  const navLinks = [...document.querySelectorAll(".oracle-links a[href], .home-links a[href]")];
  if (!navLinks.length) return;

  const here = location.pathname.replace(/\/index\.html$/, "/").replace(/(.)\/$/, "$1");
  const pathLinks = [];
  const anchorLinks = new Map();

  navLinks.forEach((link) => {
    const href = link.getAttribute("href");
    if (href.startsWith("#")) {
      const target = document.getElementById(href.slice(1));
      if (target) anchorLinks.set(target, link);
      return;
    }
    let linkPath;
    try {
      linkPath = new URL(href, location.origin).pathname;
    } catch {
      return;
    }
    linkPath = linkPath.replace(/\/index\.html$/, "/").replace(/(.)\/$/, "$1");
    if (linkPath === here) pathLinks.push(link);
  });

  pathLinks.forEach((link) => link.setAttribute("aria-current", "page"));

  // Scroll-spy for same-page anchor nav (the homepage's #signaux/#intelligence/etc
  // sections) -- highlights whichever section is currently in view as the user scrolls.
  if (anchorLinks.size) {
    const setActive = (target) => {
      anchorLinks.forEach((link, section) => {
        if (section === target) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target);
      },
      { rootMargin: "-40% 0px -50% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    anchorLinks.forEach((_, section) => observer.observe(section));
  }
})();
