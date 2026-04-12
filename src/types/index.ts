export type ManufacturerId =
  | "sangetsu"
  | "lilycolor"
  | "sincol"
  | "toli"
  | "other";

/** 品番カタログ等で分かる公式リピート情報（from_product のみ） */
export type RepeatInfo = {
  from_product: string;
};

/** 品番ごとの1行分の寸法・数量 */
export type MemoEntry = {
  original_formula: string;
  length_m: number;
  quantity: number;
  subtotal_m: number;
};

/** 品番単位で集約された1ブロック（AI出力スキーマ） */
export type MemoProductItem = {
  product_code: string;
  manufacturer: string;
  entries: MemoEntry[];
  total_m: number;
  order_quantity: number;
  /** product_master 等で補完した規格（未登録時は API で「規格情報なし」） */
  spec?: string;
  repeat_info?: RepeatInfo;
  /** 品番単位の備考（柄合わせ等） */
  notes?: string;
  /** AIまたはロジックで抽出された機能タグ（例: 防カビ、下地注意など） */
  tags?: string[];
  /** 参照したカタログの名前 */
  catalog_name?: string;
  /** 参照したカタログのページ番号 */
  catalog_page_num?: string;
  /** この品番ブロックの読み取り確信度 0〜1 */
  confidence?: number;
  /** カタログ／推測の確認が推奨されるとき true */
  needs_review?: boolean;
  /** 情報の取得元URL */
  source_url?: string;
  /** Google検索等のライブ検索で自動補完された情報かどうか */
  is_live_searched?: boolean;
};

/** /api/parse-memo の data 本体 */
export type ParsedMemoPayload = {
  items: MemoProductItem[];
  notes?: string;
  /** いずれかの品番で要確認が立っている */
  needs_review_any?: boolean;
};
