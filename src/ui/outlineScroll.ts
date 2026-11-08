/** Scroll only the outline's own container, leaving the editor viewport untouched. */
export function revealOutlineItem(container: HTMLElement, item: HTMLElement): boolean {
  const bounds = container.getBoundingClientRect();
  const target = item.getBoundingClientRect();
  const top = bounds.top + 6;
  const bottom = bounds.bottom - 6;
  if (target.top < top) container.scrollTop -= top - target.top;
  else if (target.bottom > bottom) container.scrollTop += target.bottom - bottom;
  else return false;
  return true;
}
