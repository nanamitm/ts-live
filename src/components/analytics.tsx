import Script from 'next/script'

// Google Analytics。計測 ID は環境変数 NEXT_PUBLIC_GA_ID で渡す。未設定なら
// 何も読み込まない (フォークして自分の環境に置いた場合に、他人の計測 ID へ
// アクセスが送られてしまうのを防ぐため、既定を「送らない」にしてある)。
const gaId = process.env.NEXT_PUBLIC_GA_ID

const Analytics: React.FC = () => {
  if (!gaId) return null
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){window.dataLayer.push(arguments);}
            gtag('js', new Date());

            gtag('config', '${gaId}');
          `}
      </Script>
    </>
  )
}

export default Analytics
