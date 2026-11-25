// 极简 hyperscript 与 UI 工具
export type ElChild = Node | string | number | false | null | undefined | ElChild[];

export type HProps = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  html?: string;
} & Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: HProps | null,
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
      else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else {
        (el as any)[k] = v;
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: ElChild[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(container: HTMLElement, node: Node) {
  clear(container);
  container.appendChild(node);
}

let toastWrap: HTMLDivElement | null = null;
export function toast(message: string, kind: '' | 'good' | 'bad' = '', timeout = 3600) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap' }) as HTMLDivElement;
    document.body.appendChild(toastWrap);
  }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastWrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, timeout);
}

export function pct(x: number | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${x.toFixed(digits)}%`;
}

export function deg(x: number | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${x.toFixed(digits)}°`;
}
