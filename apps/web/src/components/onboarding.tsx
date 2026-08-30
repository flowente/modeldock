export function OnboardingCard({
  ctaLabel,
  description,
  href,
  step,
  title
}: {
  ctaLabel: string;
  description: string;
  href: string;
  step: string;
  title: string;
}) {
  return (
    <article className="onboarding-card">
      <span className="step-badge">{step}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      <a className="link-button" href={href} rel={href.startsWith("http") ? "noreferrer" : undefined} target={href.startsWith("http") ? "_blank" : undefined}>
        {ctaLabel}
      </a>
    </article>
  );
}
