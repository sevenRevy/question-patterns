export interface BooleanSwitchProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  title?: string;
  onChange: (checked: boolean) => void;
}

// Shared by React editors and the session picker's DOM controls.
export const BOOLEAN_SWITCH_MARKUP = '<span aria-hidden="true" class="qp-switch-track"><span class="qp-switch-thumb"><svg class="qp-switch-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 8 3 3 5-6"/></svg></span></span>';

export function createBooleanSwitch(initial: BooleanSwitchProps) {
  const element = document.createElement('div');
  element.className = 'qp-pattern-toggle';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'qp-enabled-switch';
  button.setAttribute('role', 'switch');
  button.innerHTML = BOOLEAN_SWITCH_MARKUP;
  element.append(button);
  let props = initial;
  const update = (next: BooleanSwitchProps) => {
    props = next;
    button.setAttribute('aria-checked', String(props.checked));
    button.setAttribute('aria-label', props.label);
    if (props.describedBy) button.setAttribute('aria-describedby', props.describedBy);
    else button.removeAttribute('aria-describedby');
    button.dataset.enabled = String(props.checked);
    button.disabled = !!props.disabled;
    button.title = props.title ?? props.label;
  };
  button.onclick = () => { if (!button.disabled) props.onChange(!props.checked); };
  update(initial);
  return { element, button, update };
}
