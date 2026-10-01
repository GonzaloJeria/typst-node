import type { DefaultTreeAdapterMap } from "parse5";
import type { SelectorElement } from "./css/selector.js";

export type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];
export type TextNode = DefaultTreeAdapterMap["textNode"];

export function isElement(n: Node): n is Element {
  return "tagName" in n;
}

export function isText(n: Node): n is TextNode {
  return n.nodeName === "#text";
}

export function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function childElements(el: Element): Element[] {
  return el.childNodes.filter(isElement);
}

export function findFirst(root: Node, tag: string): Element | undefined {
  if (isElement(root) && root.tagName === tag) return root;
  for (const child of "childNodes" in root ? root.childNodes : []) {
    const found = findFirst(child, tag);
    if (found) return found;
  }
  return undefined;
}

export function findAll(root: Node, tag: string, out: Element[] = []): Element[] {
  if (isElement(root) && root.tagName === tag) out.push(root);
  for (const child of "childNodes" in root ? root.childNodes : []) findAll(child, tag, out);
  return out;
}

/** Adapts a parse5 element to the selector matcher (memoized per element). */
const adapters = new WeakMap<Element, SelectorElement>();
export function selectorElement(el: Element): SelectorElement {
  let a = adapters.get(el);
  if (!a) {
    a = {
      tagName: el.tagName,
      getAttribute: (name) => attr(el, name),
      parent: () => {
        const p = el.parentNode;
        return p && isElement(p) ? selectorElement(p) : undefined;
      },
      position: () => {
        const p = el.parentNode;
        const siblings = p && "childNodes" in p ? p.childNodes.filter(isElement) : [el];
        return { index: siblings.indexOf(el) + 1, count: siblings.length };
      },
      siblings: () => {
        const p = el.parentNode;
        return (p && "childNodes" in p ? p.childNodes.filter(isElement) : [el]).map(selectorElement);
      },
      children: () => childElements(el).map(selectorElement),
      isEmpty: () => el.childNodes.every((n) => !isElement(n) && !(isText(n) && n.value.length > 0)),
    };
    adapters.set(el, a);
  }
  return a;
}
