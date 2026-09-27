export function createManualDrawHandler(input, manual) {
  return () => {
    if (!input.checkValidity()) {
      input.reportValidity();
      return;
    }
    manual(input.valueAsNumber);
  };
}
