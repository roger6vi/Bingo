// Only IPC acknowledgement may replace the displayed event history.
const connectionError = 'Could not connect to the event. Reload and try again.';

export function createOperatorController(api, view) {
  let calledNumbers = [];
  let pending = false;
  let stale = false;
  let error = null;
  let loaded = false;

  function render() {
    const exhausted = calledNumbers.length === 90;
    view.render({ calledNumbers: [...calledNumbers], remaining: 90 - calledNumbers.length,
      stale, error, pending, manualDisabled: pending || !loaded || exhausted,
      digitalDisabled: pending || !loaded || exhausted, reloadDisabled: pending });
  }

  async function request(operation, manual = false) {
    if (pending) return;
    pending = true;
    render();
    try {
      const result = await operation();
      if (result.ok) {
        calledNumbers = [...result.snapshot.calledNumbers];
        loaded = true;
        stale = false;
        error = null;
        if (manual) view.clearManual();
      } else {
        stale = true;
        error = result.message;
      }
    } catch {
      stale = true;
      error = connectionError;
    } finally {
      pending = false;
      render();
    }
  }

  const reload = () => request(() => api.getCurrentEvent());
  const manual = (number) => {
    if (!loaded || calledNumbers.length === 90) return;
    void request(() => api.drawManual(number), true);
  };
  const digital = () => {
    if (!loaded || calledNumbers.length === 90) return;
    void request(() => api.drawDigital());
  };
  view.bind({ manual, digital, reload: () => { void reload(); } });
  render();
  return { start: reload };
}
