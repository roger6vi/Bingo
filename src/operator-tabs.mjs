// WAI-ARIA tabs with automatic activation and a roving tabindex.
export function bindTabs(tablist) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

  function select(next, focus = false) {
    for (const tab of tabs) {
      const selected = tab === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panelOf(tab).hidden = !selected;
    }
    if (focus) next.focus();
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tabs.includes(tab)) select(tab);
  });
  tablist.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index === -1) return;
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(tabs[(target + tabs.length) % tabs.length], true);
  });
  select(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0]);
  return { select: (id) => select(tabs.find((tab) => tab.id === id)) };
}
