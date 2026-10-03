export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="mb-8 space-y-2">
        <div className="h-7 w-48 animate-pulse rounded bg-[var(--bg-raised)]" />
        <div className="h-4 w-72 animate-pulse rounded bg-[var(--bg-raised)]" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]"
          />
        ))}
      </div>
    </div>
  );
}