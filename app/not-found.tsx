export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-4 text-5xl">🔒</div>
        <h1 className="text-xl font-semibold text-zinc-100">Link not valid</h1>
        <p className="mt-3 text-sm text-zinc-400">
          This link doesn&apos;t exist, has been revoked, or has expired.
        </p>
      </div>
    </main>
  );
}
