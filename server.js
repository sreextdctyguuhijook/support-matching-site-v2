const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);

const API_BASE =
  "https://apis.data.go.kr/B552745/pmPbancService/pmPbancList";

/*
  기존 Render 환경변수 이름을 우선 인식합니다.
  API 인증키를 코드에 직접 입력하지 마세요.
*/
const API_KEY =
  process.env.DATA_GO_KR_SERVICE_KEY ||
  process.env.DATA_API_KEY ||
  process.env.SERVICE_KEY ||
  process.env.API_KEY ||
  process.env.OPEN_API_KEY ||
  process.env.KEY ||
  process.env.DATA_GO_KR_KEY ||
  "";

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

/* 공공데이터 API 페이지 요청 */
function requestPage(pageNo, rows = 100) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      return reject(
        new Error(
          "Render 환경변수에 API 인증키가 설정되어 있지 않습니다."
        )
      );
    }

    const url = new URL(API_BASE);

    url.searchParams.set("serviceKey", API_KEY);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("numOfRows", String(rows));
    url.searchParams.set("type", "json");

    const request = https.get(
      url,
      { timeout: 25000 },
      response => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            return reject(
              new Error(
                `공공데이터 API HTTP ${response.statusCode}`
              )
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(
              new Error(
                "공공데이터 API 응답을 JSON으로 읽을 수 없습니다."
              )
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("공공데이터 API 응답 시간이 초과되었습니다.")
      );
    });

    request.on("error", reject);
  });
}

/* API 응답에서 공고 배열 찾기 */
function findItems(data) {
  const candidates = [
    data?.response?.body?.items?.item,
    data?.response?.body?.items,
    data?.body?.items?.item,
    data?.body?.items,
    data?.items?.item,
    data?.items,
    data?.data?.items,
    data?.data
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value && typeof value === "object") {
      return [value];
    }
  }

  return [];
}

/* 전체 공고 수 확인 */
function readTotalCount(data) {
  const value =
    data?.response?.body?.totalCount ??
    data?.body?.totalCount ??
    data?.totalCount;

  return Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

/* API 원본 항목을 화면에서 사용하는 형식으로 변환 */
function mapItem(item) {
  function pick(...keys) {
    for (const key of keys) {
      if (
        item?.[key] != null &&
        item[key] !== ""
      ) {
        return item[key];
      }
    }

    return "";
  }

  return {
    title: pick(
      "title",
      "pbancNm",
      "pblancNm",
      "bizPbancNm",
      "사업명"
    ),

    provider: pick(
      "provider",
      "sprvsnInstNm",
      "jrsdInstNm",
      "기관명"
    ),

    pbancBgngYmd: pick(
      "pbancBgngYmd",
      "aplyBgngYmd",
      "startDate",
      "beginDate"
    ),

    pbancEndYmd: pick(
      "pbancEndYmd",
      "aplyEndYmd",
      "endDate",
      "closeDate"
    ),

    content: pick(
      "content",
      "pbancCn",
      "bsnsSumryCn",
      "detailCn",
      "description",
      "sprtCn",
      "공고내용"
    ),

    applyUrl: pick(
      "applyUrl",
      "aplyUrlAddr",
      "detailUrl",
      "pblancUrl",
      "dtlUrl",
      "url"
    )
  };
}

/* 최대 10페이지까지 공고 수집 */
async function getPrograms() {
  const results = [];
  const seen = new Set();

  let totalCount = null;

  for (let page = 1; page <= 10; page++) {
    const response = await requestPage(page, 100);

    if (totalCount === null) {
      totalCount = readTotalCount(response);
    }

    const rows = findItems(response);

    for (const rawItem of rows) {
      const item = mapItem(rawItem);

      const uniqueKey = [
        item.title,
        item.provider,
        item.pbancBgngYmd,
        item.pbancEndYmd
      ].join("|");

      if (item.title && !seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        results.push(item);
      }
    }

    if (rows.length === 0) {
      break;
    }

    if (rows.length < 100) {
      break;
    }

    if (
      totalCount !== null &&
      results.length >= totalCount
    ) {
      break;
    }
  }

  return results;
}

/* 정적 파일 MIME 유형 */
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const rootDirectory = path.resolve(__dirname);

/* 서버 */
const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  /* 서버 상태 확인 */
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      success: true,
      status: "live"
    });
  }

  /* 지원사업 공고 API */
  if (url.pathname === "/api/programs/social-enterprise") {
    try {
      const items = await getPrograms();

      return sendJson(res, 200, {
        success: true,
        count: items.length,
        items
      });

    } catch (error) {
      console.error("공고 API 오류:", error.message);

      return sendJson(res, 502, {
        success: false,
        message: error.message,
        items: []
      });
    }
  }

  /* 웹사이트 파일 제공 */
  let pathname;

  try {
    pathname = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname
    );
  } catch (error) {
    return sendJson(res, 400, {
      success: false,
      message: "잘못된 경로입니다."
    });
  }

  const filePath = path.resolve(
    rootDirectory,
    "." + pathname
  );

  if (
    filePath !== rootDirectory &&
    !filePath.startsWith(rootDirectory + path.sep)
  ) {
    return sendJson(res, 403, {
      success: false,
      message: "접근할 수 없는 경로입니다."
    });
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type":
        mimeTypes[path.extname(filePath)] ||
        "application/octet-stream",
      "Cache-Control": "no-cache"
    });

    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Support matching server listening on ${PORT}`);
});