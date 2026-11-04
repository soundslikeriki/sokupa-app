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
  source_row_id?: string;
  source_image_index?: number;
  source_entry_index?: number;
  original_formula: string;
  length_m: number;
  quantity: number;
  /** Incomplete editor input. Numeric fields retain the last valid measurements. */
  length_input?: string;
  quantity_input?: string;
  subtotal_m: number;
  needs_review?: boolean;
  review_reason?: string;
  repeat_enabled?: boolean;
};

/** OCR ambiguity about a correction, cancellation or excluded formula; never auto-add it. */
export type MemoReadingReview = {
  reason: string;
  candidate_formulas: string[];
  source_image_index?: number;
};

/** 品番単位で集約された1ブロック（AI出力スキーマ） */
export type MemoProductItem = {
  reading_reviews?: MemoReadingReview[];
  reading_review_confirmation?: string;
  /** Simple memo use is the default; legacy active repeat drafts reopen the pattern editor. */
  order_mode?: "memo" | "pattern";
  /** Remember an intentional all-rows-OFF setting when the pattern editor is hidden. */
  pattern_rows_configured?: boolean;
  memo_allowance?: "add" | "included";
  loss_rate_input?: string;
  repeat_cm_input?: string;
  repeat_height_input?: string;
  measurement_basis?: "unconfirmed" | "trim-included" | "repeat-adjusted";
  pattern_match?: "unconfirmed" | "straight" | "other";
  quantity_confirmation?: string;
  /** Incomplete/invalid editor input; keep the last valid numeric quantity separately. */
  order_quantity_input?: string;
  product_code: string;
  manufacturer: string;
  entries: MemoEntry[];
  total_m: number;
  order_quantity: number;
  repeat_cm?: number;
  repeat_height_m?: number;
  manual_order_quantity?: number;
  review_reasons?: string[];
  /** 品番ごとのロス率（%）。未指定時は既定値を使う */
  loss_rate_percent?: number;
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
  image_needs_review?: boolean;
  notes?: string;
  /** いずれかの品番で要確認が立っている */
  needs_review_any?: boolean;
};

export type OrderDraftSourceType = "dimension" | "area" | "manual";

/** 計算結果から切り離した、最終発注用の軽量な下書き */
export type OrderDraftItem = {
  id: string;
  productCode: string;
  quantity: number;
  unit: string;
  manufacturer?: string;
  note?: string;
  sourceType: OrderDraftSourceType;
  sourceLabel: string;
  sourceRef?: string;
};

export type OrderDraftItemInput = Omit<OrderDraftItem, "id">;
