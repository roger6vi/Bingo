// WAI-ARIA tabs with automatic activation and a roving tabindex. canLeave(current, next) may veto
// or defer a switch (e.g. unsaved edits); it returns true to switch now, or a promise of a boolean.
export function bindTabs(tablist, { canLeave } = {}) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));
  const selected = () => tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  let deciding = false;

  function select(next, focus = false) {
    for (const tab of tabs) {
      const isSelected = tab === next;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      panelOf(tab).hidden = !isSelected;
    }
    if (focus) next.focus();
  }

  function request(next, focus = false) {
    const current = selected();
    if (deciding || next === current) return;
    const allowed = canLeave ? canLeave(current, next) : true;
    if (allowed === true) {
      select(next, focus);
      return;
    }
    // While the decision is open the current tab stays selected; a veto returns focus to it.
    deciding = true;
    Promise.resolve(allowed).catch(() => false).then((ok) => {
      deciding = false;
      if (ok === true) select(next, focus);
      else if (focus) current.focus();
    });
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tabs.includes(tab)) request(tab);
  });
  tablist.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index === -1) return;
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    request(tabs[(target + tabs.length) % tabs.length], true);
  });
  select(selected() ?? tabs[0]);
  return { select: (id) => request(tabs.find((tab) => tab.id === id)) };
}
