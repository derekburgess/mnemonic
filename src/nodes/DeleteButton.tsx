import { Icon } from "../icons";

/** Destructive, so it carries the same red treatment as Clear outputs. */
export function DeleteButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button className="icon tinted tint-err nodrag" onClick={onClick} title={title} aria-label={title}>
      <Icon name="trash" size={13} />
    </button>
  );
}
