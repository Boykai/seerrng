import type { FC } from 'react';

interface PlaceholderProps {
  canExpand?: boolean;
}

const Placeholder: FC<PlaceholderProps> = () => {
  return (
    <div
      className="poster-layout app-card-poster title-card-shell"
      data-poster-state="loading"
    />
  );
};

export default Placeholder;
