import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { assertNoUnexpectedRequests, installApiMock } from "./api.js";

let scrollIntoViewDescriptor;

beforeEach(() => {
  localStorage.clear();
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  installApiMock();
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    try {
      assertNoUnexpectedRequests();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
      } else {
        delete Element.prototype.scrollIntoView;
      }
    }
  }
});
