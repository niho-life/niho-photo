# ライセンスと公開境界

NIHOの実装はルート LICENSE.md、アイコン・校正値は ASSET_LICENSE.md に従う。使用した資産は docs/legal/asset-inventory.csv と docs/security/publication-manifest.json にSHAと由来を記録する。

第三者Rust依存はCargo.lockで固定し各crateのライセンスに従う。TauriはMIT/Apache-2.0、serde/serde_jsonはMIT/Apache-2.0、sha2はMIT/Apache-2.0、libcはMIT/Apache-2.0、rfdはMIT、chronoはMIT/Apache-2.0。完全なSBOMとrelease添付物は #2 で確定する。

本人クラウドへの明示コピーのJSON照合にはserde_jcs 0.2.0（MIT OR Apache-2.0）と推移依存ryu-js 0.2.2（Apache-2.0 OR BSL-1.0）をCargo.lockで固定する。両者のApache-2.0条件に従う。crateのsourceをこのtreeへ転記せず、正式候補のCargo SBOM・第三者noticeへ含める。ライセンス正本はそれぞれのcrates.io配布物に同梱されたものとする。

RAW/model/sidecarは #9 まで含めない。テストは合成画像・一時ファイル・承認済み校正値のみを使用し、個人写真・第三者DCPは含めない。

公開アカウントのOS callbackにはtauri-plugin-deep-link（MIT/Apache-2.0）を使用する。公開client本体と保存adapterはpackages/desktop-account/LICENSES.mdを参照。
