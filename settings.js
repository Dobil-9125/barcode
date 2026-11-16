// 상품 데이터를 읽어 올 곳 (README.md 참고)
window.BARCODE_SETTINGS = {
  // 관리자 모드: 구글시트에 붙인 Apps Script 웹 앱 주소 (https://script.google.com/macros/s/…/exec)
  // 넣으면 데이터도 여기서 읽고, 관리자 비밀번호로 웹에서 바로 상품을 고칠 수 있어요. 시트를 공개할 필요 없음
  adminApiUrl: '',

  // 관리자 모드 없이 읽기만: "링크가 있는 모든 사용자"로 공유한 구글시트 주소
  sheetCsvUrl: '',
};
// 둘 다 비워 두면 같은 폴더의 products.csv(엑셀에서 CSV로 저장)를 읽어요.
