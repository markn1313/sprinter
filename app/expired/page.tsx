export default function ExpiredPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-4 text-5xl">⏱️</div>
        <h1 className="text-2xl font-semibold text-zinc-100">Link Expired</h1>
        <p className="mt-3 text-sm text-zinc-400">
          This trip link has expired. Ask Mark for a new one.
        </p>
      </div>
    </main>
  );
}
