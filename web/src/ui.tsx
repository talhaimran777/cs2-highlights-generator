export function Progress({ value }: { value: number }) {
  return (
    <span className="progress">
      <span style={{ width: `${Math.round(value * 100)}%` }} />
      <em>{Math.round(value * 100)}%</em>
    </span>
  );
}
