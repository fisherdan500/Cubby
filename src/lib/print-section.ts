/**
 * Prints one marked section of a page (`data-print-section="<name>"`), leaving the others off the
 * paper - so the observed routine and the planned schedule, which sit on one screen, each print as
 * their own sheet and are never mistaken for one another.
 */
export function printSection(name: string) {
  const root = document.documentElement;
  root.dataset.print = name;
  const clear = () => {
    delete root.dataset.print;
    window.removeEventListener("afterprint", clear);
  };
  window.addEventListener("afterprint", clear);
  window.print();
}
