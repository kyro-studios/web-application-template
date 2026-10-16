export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 概要は日本語で書くため、大文字と小文字の規則は意味を持たない。
    // 固有名詞 (Cloud Run、API など) から書き始めると失敗してしまうため、外す
    'subject-case': [0],
  },
};
