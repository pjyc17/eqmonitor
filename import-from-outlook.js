/**
 * Outlook 메일에서 입고 데이터를 자동으로 가져와서 서버에 전송하는 스크립트
 *
 * 사용법:
 *   node import-from-outlook.js
 *
 * 동작:
 *   1. Outlook에서 "프레임 입고" 관련 최신 메일을 찾음
 *   2. 메일 본문의 테이블을 파싱
 *   3. 서버 API로 데이터 전송
 *
 * 자동 실행 (Windows 작업 스케줄러):
 *   - 매일 아침 메일 도착 시간 이후에 실행되도록 설정
 *   - 예: 매일 오전 8:00에 실행
 */

const http = require('http');

const SERVER_URL = 'http://localhost:3000';

function parseEmailTable(htmlBody) {
  const items = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch;
  while ((rowMatch = rowRegex.exec(htmlBody)) !== null) {
    const cells = [];
    let cellMatch;
    const rowContent = rowMatch[1];
    const localCellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = localCellRegex.exec(rowContent)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]*>/g, '').trim());
    }

    if (cells.length < 4) continue;

    const lineMatch = cells[0].match(/^([A-Z])-(\d+)$/);
    if (!lineMatch) continue;

    items.push({
      line: lineMatch[1],
      number: parseInt(lineMatch[2], 10),
      lotNo: cells[1] || null,
      model: cells[2] || null,
      vendor: cells.length >= 5 ? cells[4] : null,
      priority: cells.length >= 6 ? parseInt(cells[5], 10) || null : null,
    });
  }

  return items;
}

function parsePlainText(text) {
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  for (const line of lines) {
    const parts = line.split(/\t+|\s{2,}/).map(p => p.trim()).filter(p => p);
    if (parts.length < 3) continue;

    const lineMatch = parts[0].match(/^([A-Z])-(\d+)$/);
    if (!lineMatch) continue;

    items.push({
      line: lineMatch[1],
      number: parseInt(lineMatch[2], 10),
      lotNo: parts[1] || null,
      model: parts[2] || null,
      vendor: parts.length >= 5 ? parts[4] : null,
      priority: parts.length >= 6 ? parseInt(parts[5], 10) || null : null,
    });
  }

  return items;
}

function sendToServer(items) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(items);
    const url = new URL('/api/receive-bulk', SERVER_URL);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`서버 응답 파싱 실패: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    const fs = require('fs');
    const filePath = args[0];
    const content = fs.readFileSync(filePath, 'utf8');

    let items;
    if (content.includes('<table') || content.includes('<tr')) {
      items = parseEmailTable(content);
    } else {
      items = parsePlainText(content);
    }

    if (items.length === 0) {
      console.log('파싱된 데이터가 없습니다. 파일 형식을 확인하세요.');
      process.exit(1);
    }

    console.log(`${items.length}건의 입고 데이터를 파싱했습니다:`);
    items.forEach(item => {
      console.log(`  ${item.line}-${String(item.number).padStart(2, '0')} | ${item.model} | ${item.lotNo} | 우선순위: ${item.priority}`);
    });

    try {
      const result = await sendToServer(items);
      console.log(`\n서버 전송 완료: ${result.message}`);
    } catch (err) {
      console.error(`\n서버 전송 실패: ${err.message}`);
      console.error('서버가 실행 중인지 확인하세요 (node server.js)');
    }
  } else {
    console.log('');
    console.log('사용법:');
    console.log('  node import-from-outlook.js <파일경로>');
    console.log('');
    console.log('예시:');
    console.log('  node import-from-outlook.js mail.txt     (탭 구분 텍스트)');
    console.log('  node import-from-outlook.js mail.html    (HTML 테이블)');
    console.log('');
    console.log('또는 웹앱의 "메일 가져오기" 버튼을 사용하세요.');
    console.log('');
  }
}

main();
