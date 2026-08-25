export function LibraryGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,280px))] gap-4">{children}</div>
  );
}
