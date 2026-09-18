'use client';

import { useFormStatus } from 'react-dom';

export default function AdminSubmitButton({
  children,
  pendingText = 'Jobber …',
  className = '',
  type = 'submit',
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type={type}
      className={`adminLoadingButton ${className}`.trim()}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? <span className="adminSpinner" aria-hidden="true"/> : null}
      <span>{pending ? pendingText : children}</span>
    </button>
  );
}
