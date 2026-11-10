import { Link } from 'react-router';

/**
 * Renders a copy string with one phrase inside it turned into a link (for example "Terms" in
 * the age line). The whole string still comes from the copy deck.
 */
export function TextWithLink({
  text,
  linkText,
  to,
}: {
  text: string;
  linkText: string;
  to: string;
}) {
  const index = text.lastIndexOf(linkText);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <Link to={to}>{linkText}</Link>
      {text.slice(index + linkText.length)}
    </>
  );
}
