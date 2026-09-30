import { Icon } from "../icons";

/** Destructive, so it carries the same red treatment as Clear outputs. */
export function DeleteButton({ onClick, title, disabled }: { onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button className="icon tinted tint-err nodrag" onClick={onClick} disabled={disabled} title={title} aria-label={title}>
      <Icon name="trash" size={13} />
    </button>
  );
}
