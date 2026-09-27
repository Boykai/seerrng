import { getSafeHref } from '@app/utils/safeUrl';

export default function CollectionOverview({
  text,
  source,
}: {
  text: string;
  source?: { name: string; url: string };
}) {
  const href = getSafeHref(source?.url);
  return (
    <>
      {text}
      {source && href && (
        <>
          {' '}
          <a
            className="text-xs underline"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {source.name}
          </a>
        </>
      )}
    </>
  );
}
