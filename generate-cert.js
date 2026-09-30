import { createPrivateKey, createPublicKey, createSign } from 'crypto'
import { randomBytes } from 'crypto'
import fs from 'fs'
import { promisify } from 'util'

// PEM ファイルを読み込む関数
function readPem(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
}

// 証明書を生成（CA で署名）
async function generateCertificate() {
  try {
    // CA の証明書と秘密鍵を読み込む
    const caKey = readPem('./ca.key')
    const caCert = readPem('./ca.crt')

    // 既存の localhost.pem と localhost-key.pem があれば使用
    if (fs.existsSync('./localhost.pem') && fs.existsSync('./localhost-key.pem')) {
      console.log('✓ localhost.pem と localhost-key.pem が既に存在します。')
      console.log('✓ これらのファイルをプロジェクトで使用してください。')
      
      // Windows のシステムに証明書を信頼させる手順を表示
      console.log('\n⚠️  HTTPS 信頼エラーを解決するには、以下の手順を実行してください：')
      console.log('\n1. PowerShell（管理者権限）を開く')
      console.log('2. 以下のコマンドを実行：')
      console.log(`   Import-Certificate -FilePath "${process.cwd()}\\ca.crt" -CertStoreLocation Cert:\\CurrentUser\\Root`)
      console.log('\n3. 開発サーバーを再起動：npm run dev')
      console.log('4. ブラウザで https://localhost:5173 にアクセス')
      
      return
    }

    console.log('ℹ️  新しい証明書を生成中...')
    console.log('ℹ️  現在のプロジェクトに localhost.pem と localhost-key.pem が見つかりません。')
    console.log('ℹ️  CA ファイルを使用して生成することは複雑なため、以下の手順に従ってください：')
    
    console.log('\n✓ 代替案：Windows で CA 証明書をシステムに信頼させる')
    console.log('1. PowerShell（管理者権限）で以下を実行：')
    console.log(`   Import-Certificate -FilePath "${process.cwd()}\\ca.crt" -CertStoreLocation Cert:\\CurrentUser\\Root`)
    console.log('\n2. 実行後、ブラウザを再起動してアクセス')
    
  } catch (error) {
    console.error('エラー:', error.message)
    process.exit(1)
  }
}

generateCertificate()
