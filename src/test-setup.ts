import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Lazy-loaded screens are transformed on first use; give async queries room on a cold start.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no <dialog> modal support; emulate the parts our Dialog relies on.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
