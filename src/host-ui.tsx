import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BOOLEAN_SWITCH_MARKUP, type BooleanSwitchProps } from './boolean-switch';
import type { PluginFrontendContext, PluginButtonProps, PluginModelPickerProps, PluginThinkingPickerProps, PluginWidgetHandle, PluginMarkdownProps, PluginSettingsSchema } from 'learnharness-plugin-api';

export interface Host { ctx: PluginFrontendContext; signal: AbortSignal }
export const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
export function BooleanSwitch({ label, checked, disabled, describedBy, title, onChange }: BooleanSwitchProps) {
  return <div className="qp-pattern-toggle"><button type="button" role="switch" className="qp-enabled-switch"
    aria-label={label} aria-checked={checked} aria-describedby={describedBy} data-enabled={checked}
    title={title ?? label} disabled={disabled} onClick={() => onChange(!checked)}
    dangerouslySetInnerHTML={{ __html: BOOLEAN_SWITCH_MARKUP }} /></div>;
}
function Widget<P>({ host, props, mount, className }: {
  host: Host; props: P; mount: (container: HTMLElement, props: P, signal: AbortSignal) => PluginWidgetHandle<P>; className?: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const handle = useRef<PluginWidgetHandle<P> | null>(null);
  const latest = useRef({ props, mount });
  latest.current = { props, mount };
  useLayoutEffect(() => {
    if (host.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    host.signal.addEventListener('abort', abort, { once: true });
    handle.current = latest.current.mount(element.current!, latest.current.props, controller.signal);
    return () => {
      host.signal.removeEventListener('abort', abort);
      controller.abort(); handle.current?.dispose(); handle.current = null;
    };
  }, [host]);
  useLayoutEffect(() => { handle.current?.update(props); });
  return <div ref={element} className={className} />;
}
export function HostButton({ host, ...props }: PluginButtonProps & { host: Host }) {
  return <Widget host={host} props={props} mount={(node, value, signal) => host.ctx.ui.mountButton(node, value, { signal })} />;
}
export function SettingsRows({ host, ...props }: PluginSettingsSchema & { host: Host }) {
  return <Widget host={host} props={props} mount={(node, value, signal) => host.ctx.ui.mountSettingsRows(node, value, { signal })} />;
}
export function ModelPicker({ host, ...props }: PluginModelPickerProps & { host: Host }) {
  return <Widget host={host} props={props} mount={(node, value, signal) => host.ctx.ui.mountModelPicker(node, value, { signal })} />;
}
export function ThinkingPicker({ host, ...props }: PluginThinkingPickerProps & { host: Host }) {
  return <Widget host={host} props={props} mount={(node, value, signal) => host.ctx.ui.mountThinkingPicker(node, value, { signal })} />;
}
export function Markdown({ host, text }: PluginMarkdownProps & { host: Host }) {
  return <Widget host={host} props={{ text }} mount={(node, value, signal) => host.ctx.ui.mountMarkdown(node, value, { signal })} />;
}
export function MenuButton({ host, label, icon, disabled, items }: { host: Host; label: string; icon?: string; disabled?: boolean; items: Array<{ key: string; label: string; disabled?: boolean; onSelect: () => void | Promise<void> }> }) {
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<ReturnType<Host['ctx']['ui']['openMenu']> | null>(null);
  useLayoutEffect(() => () => menu.current?.dispose(), [host]);
  return <div ref={anchor}><HostButton host={host} label={label} icon={icon} iconOnly={!!icon} disabled={disabled}
    size={icon ? 'icon-sm' : undefined} title={label} variant="ghost" onClick={() => {
    menu.current?.dispose();
    menu.current = host.ctx.ui.openMenu(anchor.current!, { label, items }, { signal: host.signal });
  }} /></div>;
}
// The host owns the modal frame, scrolling, close control and focus; portals retain React context.
export function Dialog({ host, title, onClose, children }: { host: Host; title: string; onClose: () => void; children: (host: Host) => ReactNode }) {
  const [mount, setMount] = useState<{ node: HTMLElement; host: Host } | null>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    if (host.signal.aborted) return;
    const dialog = host.ctx.ui.openDialog({ title, onClose: () => close.current(), content(node, signal) {
      // Keep the portal target intact even if host disposal clears its own container first.
      const target = document.createElement('div'); node.append(target);
      setMount({ node: target, host: { ctx: host.ctx, signal } });
    } }, { signal: host.signal });
    return () => dialog.dispose();
  }, [host, title]);
  return mount ? createPortal(<div className="qp-library qp-dialog-content">{children(mount.host)}</div>, mount.node) : null;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="qp-field"><span>{label}</span>{children}</label>;
}
