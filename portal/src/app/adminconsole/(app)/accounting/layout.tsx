import type { ReactNode } from 'react';

/** Everything under Accounting is styled with the QuickBooks-style theme (.qb in globals.css). */
export default function AccountingLayout({ children }: { children: ReactNode }) {
  return <div className="qb">{children}</div>;
}
