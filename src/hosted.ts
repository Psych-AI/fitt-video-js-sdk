// The hosted build's entry: the IIFE sets window.FittVideo to these exports.
import { defineFittRecorder } from './ui/element.ts';

export * from './index.ts';
export { defineFittRecorder };

// A page that loads the hosted file gets <fitt-recorder> at once; nothing runs where there is no DOM.
if (
    typeof customElements !== 'undefined' &&
    !customElements.get('fitt-recorder')
) {
    defineFittRecorder();
}
