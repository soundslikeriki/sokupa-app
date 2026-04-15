export const runtime = "nodejs";

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">利用規約</h1>
        <p className="mt-2 text-sm text-muted-foreground">ソクパ（Sokupa）をご利用いただく前に、以下をご確認ください。</p>
      </header>

      <section className="space-y-6 text-sm leading-relaxed">
        <div className="space-y-2">
          <h2 className="text-base font-semibold">1. 適用</h2>
          <p>
            本利用規約（以下「本規約」）は、ソクパ（Sokupa）（以下「本サービス」）の利用条件を定めるものです。ユーザーは本規約に同意のうえ本サービスを利用するものとします。
          </p>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-semibold">2. 利用目的</h2>
          <p>本サービスは個人利用目的に限り利用できます。営利目的での使用を禁止します。</p>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-semibold">3. 招待制</h2>
          <p>本サービスは招待制です。招待コードの第三者への譲渡、共有、転売を禁止します。</p>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-semibold">4. AI解析結果について</h2>
          <p>
            本サービスのAI解析結果は参考情報です。内容の正確性・完全性・有用性を保証するものではありません。最終的な判断はユーザーの責任で行ってください。
          </p>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-semibold">5. 変更・終了</h2>
          <p>本サービスは、ユーザーへの事前の通知なく内容の変更、提供の中断または終了を行う場合があります。</p>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-semibold">6. 禁止事項</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>過度なアクセス、負荷を与える行為</li>
            <li>不正アクセス、またはこれを試みる行為</li>
            <li>リバースエンジニアリング、解析、改変を試みる行為</li>
            <li>本サービスの運営を妨げる行為</li>
            <li>法令または公序良俗に反する行為</li>
          </ul>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-semibold">7. 免責事項</h2>
          <p>
            当方は、本サービスの利用または利用不能によりユーザーに生じた損害について、当方に故意または重過失がある場合を除き、一切の責任を負いません。
          </p>
        </div>
      </section>
    </main>
  );
}

