// Rendered instantly by Next.js during navigation to a campaign, so clicking a
// row gives immediate feedback instead of the list sitting there frozen while
// the server component resolves. Mirrors the inbox layout (header strip +
// contact rail + conversation).
export default function CampaignDetailLoading() {
  const block = 'animate-pulse rounded-md bg-slate-200/70';
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[#fbfbfc] p-6">
      {/* Header strip */}
      <div className="mb-4 flex shrink-0 items-center gap-4">
        <div className={`${block} size-9 rounded-xl`} />
        <div className={`${block} size-10 rounded-xl`} />
        <div className="space-y-2">
          <div className={`${block} h-5 w-56`} />
          <div className={`${block} h-3 w-32`} />
        </div>
        <div className={`${block} ml-2 h-11 w-80 rounded-xl`} />
        <div className="ml-auto flex gap-2">
          <div className={`${block} h-9 w-24 rounded-xl`} />
          <div className={`${block} h-9 w-24 rounded-xl`} />
        </div>
      </div>

      {/* Inbox body */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Contact rail */}
        <div className="flex w-72 shrink-0 flex-col gap-2 rounded-2xl border border-gray-100 bg-white p-3 shadow-sm">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 p-1">
              <div className={`${block} size-8 rounded-full`} />
              <div className="flex-1 space-y-1.5">
                <div className={`${block} h-3 w-3/4`} />
                <div className={`${block} h-2.5 w-1/2`} />
              </div>
            </div>
          ))}
        </div>
        {/* Conversation */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className={`${block} h-4 w-40`} />
          <div className="flex-1 space-y-3">
            <div className={`${block} h-12 w-2/3`} />
            <div className={`${block} ml-auto h-12 w-1/2`} />
            <div className={`${block} h-12 w-3/5`} />
          </div>
        </div>
      </div>
    </div>
  );
}
