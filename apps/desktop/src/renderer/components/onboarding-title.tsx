export function OnboardingTitle({
  text,
  offset = 0,
}: {
  text: string;
  offset?: number;
}) {
  return (
    <span>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {Array.from(text).map((character, index) => (
          <span
            key={index}
            className="onboarding-title-character"
            style={{ animationDelay: `${100 + (offset + index) * 32}ms` }}
          >
            {character}
          </span>
        ))}
      </span>
    </span>
  );
}
