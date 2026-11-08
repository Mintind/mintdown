// CodeMirror measures text on animation frames; jsdom does not implement layout.
if (!Range.prototype.getClientRects)
  Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
if (!Range.prototype.getBoundingClientRect)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }),
  });
