import { Eyebrow } from '@meritbooks/merit-ui';
import { HelpButton } from '@/components/help/help-button';
import { ActiveCompanyIndicator } from './active-company-indicator';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  /** Tracked-caps line over the title ("Settings // Team & access"). Parts join with the blue //. */
  eyebrow?: string | string[];
}

/**
 * The page head on merit-ui (kit `.page-head`): an optional `02 // Label` eyebrow,
 * ONE Syne 28 Electric title (the page's only h1), a Steel caption, and the page's
 * verbs bottom-right (one primary). Breadcrumbs, when a page passes them, become the
 * eyebrow — the bar already carries the trail. Same props as before, so every page
 * keeps compiling.
 */
export function PageHeader({ title, description, actions, breadcrumbs, eyebrow }: PageHeaderProps) {
  const eyebrowParts = eyebrow
    ? Array.isArray(eyebrow)
      ? eyebrow
      : [eyebrow]
    : breadcrumbs && breadcrumbs.length > 0
      ? breadcrumbs.map((b) => b.label)
      : null;
  return (
    <div className="page-head mb-page-head">
      <div className="mb-page-head-main">
        {eyebrowParts && <Eyebrow>{eyebrowParts}</Eyebrow>}
        <h1 className="t-title" style={eyebrowParts ? { marginTop: 4 } : undefined}>
          {title}
        </h1>
        {description && <p className="mb-page-desc">{description}</p>}
      </div>
      <div className="btn-row mb-page-actions">
        <ActiveCompanyIndicator />
        {actions}
        <HelpButton />
      </div>
    </div>
  );
}
