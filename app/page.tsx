export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-4 text-5xl">🚐</div>
        <h1 className="text-2xl font-semibold text-zinc-100">Sprinter Ops</h1>
        <p className="mt-3 text-sm text-zinc-400">
          Live operational dashboard for the Sprinter. Access is by personal link only.
        </p>
        <p className="mt-6 text-xs text-zinc-600">
          If you arrived here without a link, ask Mark.
        </p>
      </div>
    </main>
  );
}
