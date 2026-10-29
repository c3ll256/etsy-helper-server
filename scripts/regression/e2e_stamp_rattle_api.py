#!/usr/bin/env python3
"""
印章 / 摇铃新功能的端到端接口测试（M2、S2、S4、S5/C7、R1-R5）。
跑在本地后端上（默认 http://localhost:3080，连生产数据快照库），会创建 QA- 开头的测试订单、测试账号和测试模板。
需要后端开启 VARIATION_PARSER_MOCK=true（本地没有 LLM key 时用规则模拟解析）。

运行：python3 scripts/regression/e2e_stamp_rattle_api.py
测试账号的密码写到 ../.dev/test-accounts.txt，不打印。
"""
import io
import os
import secrets
import sys
import time

import openpyxl
import requests

API = os.environ.get('API', 'http://localhost:3080')
ADMIN = (os.environ.get('ADMIN_USER', 'admin'), os.environ.get('ADMIN_PASSWORD', 'admin123'))
RUN = time.strftime('%m%d%H%M%S')
ACCOUNTS_FILE = os.path.join(os.path.dirname(__file__), '..', '..', '..', '.dev', 'test-accounts.txt')

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(f"{'ok  ' if cond else 'FAIL'} - {name}{'' if cond else '：' + str(detail)[:400]}")


def login(username, password):
    r = requests.post(f'{API}/users/login', json={'username': username, 'password': password})
    r.raise_for_status()
    return {'Authorization': f"Bearer {r.json()['access_token']}"}


H = login(*ADMIN)


def get(path, headers=None, **kw):
    return requests.get(f'{API}{path}', headers=headers or H, **kw)


def post(path, body=None, headers=None, **kw):
    return requests.post(f'{API}{path}', json=body, headers=headers or H, **kw)


def put(path, body=None, headers=None):
    return requests.put(f'{API}{path}', json=body, headers=headers or H)


def patch(path, body=None, headers=None):
    return requests.patch(f'{API}{path}', json=body, headers=headers or H)


HEADERS = ['Order ID', 'Transaction ID', 'SKU', 'Quantity', 'Variations', 'Date Paid', 'Ship Name', 'Buyer', 'Note', 'Price', 'Currency']


def make_xlsx(rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(HEADERS)
    for row in rows:
        ws.append([row.get(h, '') for h in HEADERS])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def upload(rows, endpoint='/orders/upload', headers=None):
    files = {'file': (f'qa-{RUN}.xlsx', make_xlsx(rows), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
    r = requests.post(f'{API}{endpoint}', files=files, headers=headers or H)
    r.raise_for_status()
    job = r.json()['jobId']
    status_path = '/orders/upload/' + job + '/status' if endpoint == '/orders/upload' else '/rattle/upload/' + job + '/status'
    for _ in range(240):
        s = get(status_path, headers=headers).json()
        if s.get('status') in ('completed', 'failed', 'cancelled'):
            return job, s
        time.sleep(1)
    raise RuntimeError('upload timeout')


def find_order(platform_order_id, headers=None):
    items = get('/orders', headers=headers, params={'search': platform_order_id, 'limit': 50}).json()['items']
    return [o for o in items if o['platformOrderId'] == platform_order_id]


def order_detail(order_id, headers=None):
    return get(f'/orders/{order_id}', headers=headers).json()


def row(oid, sku, variations, note='', qty=1):
    return {
        'Order ID': oid, 'Transaction ID': f'{oid}-T', 'SKU': sku, 'Quantity': qty, 'Variations': variations,
        'Date Paid': '10/29/2026', 'Ship Name': 'QA Tester', 'Buyer': 'qa_buyer', 'Note': note, 'Price': 10, 'Currency': 'USD',
    }


# ---------------------------------------------------------------- M2 导入、匹配、待处理
oid_exact, oid_unmatched, oid_conflict = f'QA{RUN}1', f'QA{RUN}2', f'QA{RUN}3'
# 真实冲突：CC 的两个模板（856、975）都关联了 EB-K31-ZD；每轮用唯一后缀，避免上一轮的 SKU 关联影响结果
conflict_sku = f'EB-K31-ZD-QA{RUN}'
note = 'Please make the letters bold\nsecond line  '
job, status = upload([
    row(oid_exact, 'WD-204-ZD-black', 'Stamp Type:Black Embosser,Design Options:WD-004,Personalization:L & T', note=note),
    row(oid_unmatched, 'QA-NO-SUCH-SKU', 'Personalization:Emma'),
    row(oid_conflict, conflict_sku, 'Personalization:Mia'),
])
check('导入任务完成', status.get('status') == 'completed', status)
items = get(f'/orders/upload-jobs/{job}/items', params={'limit': 50}).json()['items']
by_order = {i['orderId']: i for i in items}
check('S1.2 未匹配的行也建单，任务明细为"已建单待处理"', by_order.get(oid_unmatched, {}).get('status') == 'pending', by_order.get(oid_unmatched))
check('S1.3 冲突的行也建单，任务明细为"已建单待处理"', by_order.get(oid_conflict, {}).get('status') == 'pending', by_order.get(oid_conflict))

exact = find_order(oid_exact)[0]
check('S1.1 WD-204-ZD-black 精确匹配到 WD-204-ZD', exact['matchStatus'] == 'exact' and exact['template']['name'] == 'WD-204-ZD', exact.get('template'))
exact_detail = order_detail(exact['id'])
check('C1/S3 备注原文和换行完整保存（不 trim）', exact_detail['etsyOrder'].get('buyerNoteRaw') == note, repr(exact_detail['etsyOrder'].get('buyerNoteRaw')))
check('C1 备注来源标记为导入原文', exact_detail['etsyOrder'].get('buyerNoteSource') == 'import')

unmatched = find_order(oid_unmatched)[0]
conflict = find_order(oid_conflict)[0]
check('S1.2 未匹配订单状态为 unmatched', unmatched['matchStatus'] == 'unmatched')
check('S1.3 冲突订单列出两个候选模板', conflict['matchStatus'] == 'conflict' and len(conflict['matchDetail']['candidates']) == 2, conflict.get('matchDetail'))

pending_ids = {o['id'] for o in get('/orders', params={'matchStatus': 'pending', 'limit': 100, 'search': f'QA{RUN}'}).json()['items']}
check('C5 待处理清单可筛出未匹配和冲突订单', {unmatched['id'], conflict['id']} <= pending_ids, pending_ids)

r = put(f"/orders/{unmatched['id']}", {'status': 'stamp_generated_reviewed'})
check('S1.2 未匹配订单不能审核通过', r.status_code == 400, r.text)
r = post('/orders/export-stamps', {'orderIds': [unmatched['id'], conflict['id']]})
check('S1.2 未匹配 / 冲突订单不能导出', r.status_code in (400, 404), r.text)
r = patch(f"/orders/{unmatched['id']}/stamp", {'templateId': 987, 'textElements': []})
check('S1.2 未匹配订单不能直接改图制单', r.status_code == 400 or not r.json().get('success', True), r.text)

# ---------------------------------------------------------------- S1.6 手动指定模板
r = patch(f"/orders/{unmatched['id']}/template", {'templateId': 987, 'scope': 'order'})
check('S1.6 仅修改当前订单：手动指定后生成设计', r.ok and r.json().get('action') == 'regenerated', r.text)
d = order_detail(unmatched['id'])
check('S1.7 手动指定的订单显示"手动指定"', d['matchStatus'] == 'manual' and d['templateId'] == 987)
tpl987 = get('/stamps/templates/987').json()
check('S1.6 仅修改当前订单不改模板的 SKU 关联', 'QA-NO-SUCH-SKU' not in (tpl987.get('skus') or []), tpl987.get('skus'))

r = patch(f"/orders/{conflict['id']}/template", {'templateId': 975, 'scope': 'sku'})
check('S1.6 同时更新 SKU 关联：指定成功', r.ok and r.json().get('action') == 'regenerated', r.text)
link = r.json().get('skuLinkUpdate') or {}
check('S1.6 完整 SKU 加到所选模板', conflict_sku in (get('/stamps/templates/975').json().get('skus') or []))
oid_after_link = f'QA{RUN}4'
upload([row(oid_after_link, conflict_sku, 'Personalization:Noah')])
after = find_order(oid_after_link)[0]
check('S1.4 更新关联后，新导入的同 SKU 订单稳定匹配到新模板', after['matchStatus'] == 'exact' and after['template']['id'] == 975, after.get('template'))

# ---------------------------------------------------------------- S1.5 重新匹配 + S1.8 / C4 覆盖确认和备份
r = patch(f"/orders/{exact['id']}/stamp", {'templateId': 987, 'textElements': exact_detail.get('stampGenerationRecords', [{}])[0].get('textElements', [])})
check('人工修改图章成功', r.ok, r.text)
check('C4 人工修改后记录"已人工调整"', order_detail(exact['id']).get('designAdjustedAt'))
r = post('/orders/reprocess', {'orderIds': [exact['id']], 'mode': 'regenerate'})
check('S1.8 已调整的设计未确认时不覆盖', r.ok and r.json()['results'][0]['action'] == 'needs_confirmation', r.text)
put(f"/orders/{exact['id']}", {'status': 'stamp_generated_reviewed'})
r = post('/orders/reprocess', {'orderIds': [exact['id']], 'mode': 'rematch', 'dryRun': True})
check('S1.5 重新匹配可预览，不改数据', r.ok and r.json()['results'][0]['action'] in ('unchanged', 'would_regenerate'), r.text)
before_urls = order_detail(exact['id'])['etsyOrder']['stampImageUrls']
r = post('/orders/reprocess', {'orderIds': [exact['id']], 'mode': 'regenerate', 'confirmOverwrite': True})
check('C4 确认后覆盖已审核设计', r.ok and r.json()['results'][0]['action'] == 'regenerated', r.text)
after_detail = order_detail(exact['id'])
check('C4 覆盖后改回待审核', after_detail['status'] == 'stamp_generated_pending_review')
check('S1.5 重新生成后预览图更新', after_detail['etsyOrder']['stampImageUrls'] != before_urls)
backups = get(f"/orders/{exact['id']}/backups").json()
check('C4 覆盖前自动备份', len(backups) >= 1 and backups[0]['stampImageUrls'] == before_urls, backups[:1])
r = post(f"/orders/{exact['id']}/backups/{backups[0]['id']}/restore")
restored = order_detail(exact['id'])
check('C4 可以从备份恢复', r.ok and restored['etsyOrder']['stampImageUrls'] == before_urls and restored['status'] == 'stamp_generated_reviewed')

# 历史错配订单 4198763377（本地快照里可能已在之前的测试中修正）
hist = find_order('4198763377')
if hist:
    h = hist[0]
    r = post('/orders/reprocess', {'orderIds': [h['id']], 'mode': 'rematch', 'dryRun': True})
    res = r.json()['results'][0]
    check('S1.1 真实订单 4198763377 重新匹配结果为 WD-204-ZD', res['templateName'] == 'WD-204-ZD', res)

# ---------------------------------------------------------------- C1 备注补录 / 历史补回
r = patch(f"/orders/{after['id']}/buyer-note", {'note': '人工补录\n第二行'})
d = order_detail(after['id'])
check('C1 按订单补录备注，标记为人工补录', r.ok and d['etsyOrder']['buyerNoteRaw'] == '人工补录\n第二行' and d['etsyOrder']['buyerNoteSource'] == 'manual')
r = post('/orders/buyer-notes/backfill', {'dryRun': True})
check('C1 历史备注补回可以预估', r.ok and 'filledOrders' in r.json(), r.text)

# ---------------------------------------------------------------- S2 账号授权
qa_user = f'qa_share_{RUN}'
qa_password = secrets.token_urlsafe(12)
r = post('/users', {'username': qa_user, 'password': qa_password, 'isAdmin': False})
check('S2 管理员可以新建账号', r.ok, r.text)
os.makedirs(os.path.dirname(ACCOUNTS_FILE), exist_ok=True)
with open(ACCOUNTS_FILE, 'a') as f:
    f.write(f'{qa_user}\t{qa_password}\t(e2e 测试账号，本地快照库)\n')
qa_id = r.json()['id']
QH = login(qa_user, qa_password)
check('S2 新账号默认看不到别人的模板', get('/stamps/templates', headers=QH, params={'limit': 5}).json()['meta']['total'] == 0)
cc_id = tpl987['userId']
r = post('/stamps/templates/shares/bulk', {'ownerUserId': cc_id, 'granteeUserIds': [qa_id], 'category': 'stamp', 'mode': 'grant'})
check('S2 批量把 CC 的印章模板授权给新账号', r.ok and r.json()['affected'] > 0, r.text)
total = get('/stamps/templates', headers=QH, params={'limit': 5}).json()['meta']['total']
check('S2 新账号能看到被授权的模板，无需重新上传', total == r.json()['templateCount'], (total, r.json()))
r = put('/stamps/templates/987', {'name': 'hack'}, headers=QH)
check('S2 被授权账号不能修改模板', r.status_code == 403, r.text)
oid_shared = f'QA{RUN}5'
upload([row(oid_shared, 'WD-204-ZD-black', 'Personalization:J & K')], headers=QH)
shared_order = find_order(oid_shared, headers=QH)
check('S2 新账号导入订单能匹配到被授权的模板', shared_order and shared_order[0]['template'] and shared_order[0]['template']['id'] == 987, shared_order)
r = post('/stamps/templates/shares/bulk', {'ownerUserId': cc_id, 'granteeUserIds': [qa_id], 'category': 'all', 'mode': 'revoke'})
check('S2 撤销授权后看不到', r.ok and get('/stamps/templates', headers=QH, params={'limit': 5}).json()['meta']['total'] == 0, r.text)

# ---------------------------------------------------------------- S4 分类
r = post('/stamp-categories', {'name': f'QA分类{RUN}'})
check('S4 新增分类', r.ok, r.text)
cat = r.json()
src = next(c for c in get('/stamp-categories').json() if c['code'] == 'steel_zhuoda')
r = post(f"/stamp-categories/{src['id']}/transfer", {'targetCode': cat['code'], 'templateIds': [987]})
check('S4 转移模板到新分类', r.ok and r.json()['moved'] == 1, r.text)
imp = get(f"/stamp-categories/{cat['id']}/impact").json()
check('S4 删除前显示关联模板和订单', len(imp['templates']) == 1 and imp['orderCount'] > 0 and not imp['canDelete'], imp)
r = requests.delete(f"{API}/stamp-categories/{cat['id']}", headers=H)
check('S4 分类下有模板时不能删除', r.status_code == 400, r.text)
r = post(f"/stamp-categories/{cat['id']}/transfer", {'targetCode': 'steel_zhuoda'})
r = requests.delete(f"{API}/stamp-categories/{cat['id']}", headers=H)
check('S4 转走模板后可以删除，模板仍在原分类', r.ok and get('/stamps/templates/987').json()['type'] == 'steel_zhuoda', r.text)
check('S4 删除分类不影响历史订单', order_detail(exact['id'])['templateId'] == 987)
rattle_cat = next(c for c in get('/stamp-categories').json() if c['code'] == 'rattle')
check('S4 系统分类（摇铃）不能删除', requests.delete(f"{API}/stamp-categories/{rattle_cat['id']}", headers=H).status_code == 400)

# ---------------------------------------------------------------- R3 图标编号 + R2 水平文字 + R1 多模板
icons = get('/rattle-icons', params={'limit': 100}).json()['items']
numeric = [i for i in icons if i['name'].strip().isdigit()]
r = post('/rattle-icons/assign-group', {'ids': [i['id'] for i in numeric], 'groupCode': 'A'})
check('R3 名称为数字的图标批量归入 A 组并自动编号', r.ok and any(x['code'] == 'A3' for x in r.json()['results']), r.text[:300])
chk = get('/rattle-icons/groups/A/check', params={'from': 1, 'to': 13}).json()
check('R3 核对 A1-A13 素材（列出缺失）', 'missing' in chk and len(chk['expected']) == 13, chk.get('missing'))

fonts = [f for f in get('/fonts').json() if f['isActive'] and not f.get('fileMissing')]
font_name = next(f['name'] for f in fonts if f['name'].lower().startswith(('arial', 'roboto', 'open', 'lato', 'montserrat'))) if any(f['name'].lower().startswith(('arial', 'roboto', 'open', 'lato', 'montserrat')) for f in fonts) else fonts[0]['name']
rattle_sku = f'QA-RATTLE-{RUN}'
tpl_body = {
    'name': f'QA摇铃{RUN}', 'type': 'rattle', 'width': 500, 'height': 500, 'skus': [rattle_sku],
    'textElements': [{
        'id': 'name', 'defaultValue': 'Emma', 'description': '名字', 'fontFamily': font_name, 'fontSize': 48, 'color': '#000000',
        'position': {'x': 250, 'y': 250, 'textAlign': 'center', 'verticalAlign': 'middle', 'isCircular': False, 'radius': 150},
        'icon': {'mode': 'byCode', 'groupCode': 'A', 'placement': 'before', 'height': 40},
    }],
}
r = post('/stamps/templates', tpl_body)
check('R2/R3 创建水平文字 + 按编号取图的摇铃模板', r.ok, r.text)
rattle_tpl = r.json()
check('R2 水平模式保存后仍保留圆弧半径参数', rattle_tpl['textElements'][0]['position'].get('radius') == 150 and rattle_tpl['textElements'][0]['position'].get('isCircular') is False)

oid_icon_ok, oid_icon_bad, oid_icon_multi = f'QA{RUN}6', f'QA{RUN}7', f'QA{RUN}8'
upload([
    row(oid_icon_ok, rattle_sku, 'Personalization:Hope icon A3'),
    row(oid_icon_bad, rattle_sku, 'Personalization:Hope icon A99'),
    row(oid_icon_multi, rattle_sku, 'Personalization:Lily A2, A9'),
], endpoint='/rattle/upload')
ok_order = find_order(oid_icon_ok)[0]
ok_rec = order_detail(ok_order['id'])['stampGenerationRecords']
check('R3 编号 A3 正确附图', ok_order['status'] == 'stamp_generated_pending_review' and ok_rec and 'icons/' in str(ok_rec[0]['textElements'][0].get('icon', {}).get('imagePath', '')), ok_rec[:1])
bad = find_order(oid_icon_bad)[0]
check('R3 图标库里没有的编号明确提示，不出图', bad['status'] == 'stamp_not_generated' and 'A99' in (bad.get('processingError') or ''), bad.get('processingError'))
multi = find_order(oid_icon_multi)[0]
check('R3 一个位置写了多个编号时提示核对', 'A2' in (multi.get('processingError') or '') and 'A9' in (multi.get('processingError') or ''), multi.get('processingError'))
check('摇铃未生成的订单出现在摇铃页的待处理清单', bad['id'] in {o['id'] for o in get('/orders', params={'matchStatus': 'pending', 'stampType': 'rattle', 'limit': 100, 'search': f'QA{RUN}'}).json()['items']})

tpl_multi_body = dict(tpl_body, name=f'QA摇铃多模板{RUN}', skus=[f'{rattle_sku}-M'], allowMultipleForSku=True)
r1 = post('/stamps/templates', tpl_multi_body)
r2 = post('/stamps/templates', dict(tpl_multi_body, name=f'QA摇铃多模板B{RUN}'))
check('R1 多模板模式下同一 SKU 可以绑定两个摇铃模板并保存', r1.ok and r2.ok, (r1.text[:200], r2.text[:200]))
check('R1 保存后重新加载仍是多模板模式', get(f"/stamps/templates/{r2.json()['id']}").json().get('allowMultipleForSku') is True)
r3 = post('/stamps/templates', dict(tpl_multi_body, name='QA非多模板', allowMultipleForSku=False))
check('R1 未开启多模板模式时仍然拒绝重复 SKU', r3.status_code == 400, r3.text[:200])
oid_multi_tpl = f'QA{RUN}9'
upload([row(oid_multi_tpl, f'{rattle_sku}-M', 'Personalization:Ava icon A3')], endpoint='/rattle/upload')
mo = find_order(oid_multi_tpl)[0]
check('R1 多模板 SKU 不自动全部生成，进入"多模板待选择"', mo['matchStatus'] == 'conflict' and mo['matchDetail'].get('reason') == 'multi_template' and mo['status'] == 'stamp_not_generated', mo.get('matchDetail'))
r = patch(f"/orders/{mo['id']}/template", {'templateId': r2.json()['id'], 'scope': 'order'})
check('R1 人工选择模板后生成', r.ok and r.json().get('action') == 'regenerated', r.text)

# ---------------------------------------------------------------- R4 清理 + R5 十列导出
put(f"/orders/{ok_order['id']}", {'status': 'stamp_generated_reviewed'})
post('/orders/reprocess', {'orderIds': [ok_order['id']], 'mode': 'regenerate', 'confirmOverwrite': True})
put(f"/orders/{ok_order['id']}", {'status': 'stamp_generated_reviewed'})
cand = get(f"/rattle/orders/{ok_order['id']}/cleanup-candidates").json()
superseded = [c for c in cand['candidates'] if c['kind'] == 'superseded']
check('R4 重新生成后被替换的旧图列为候选，当前审核结果不在候选里', len(superseded) >= 1 and all(not c['isCurrent'] for c in superseded), cand)
current_urls = order_detail(ok_order['id'])['etsyOrder']['stampImageUrls']
r = post(f"/rattle/orders/{ok_order['id']}/cleanup", {'recordIds': [superseded[0]['recordId']]})
server_root = os.path.join(os.path.dirname(__file__), '..', '..')
gone = not os.path.exists(os.path.join(server_root, 'uploads', 'stamps', os.path.basename(superseded[0]['imageUrl'])))
check('R4 清理勾选的旧图（移到回收目录）', r.ok and r.json()['cleaned'] == 1 and gone, r.text)
check('R4 有效审核结果不受影响', order_detail(ok_order['id'])['etsyOrder']['stampImageUrls'] == current_urls and all(os.path.exists(os.path.join(server_root, 'uploads', 'stamps', os.path.basename(u))) for u in current_urls))
r = post(f"/rattle/orders/{ok_order['id']}/cleanup/restore", {'recordIds': [superseded[0]['recordId']]})
check('R4 清理后可以恢复', r.ok and os.path.exists(os.path.join(server_root, 'uploads', 'stamps', os.path.basename(superseded[0]['imageUrl']))), r.text)
r = post(f"/rattle/orders/{bad['id']}/cleanup", {'recordIds': [1]})
check('R4 未审核通过的订单不能清理', r.status_code == 400, r.text)

r = post('/rattle/export-ten-columns', {'orderIds': [ok_order['id'], bad['id']]})
check('R5 十列导出成功', r.ok, r.text)
if r.ok:
    path = os.path.join(server_root, r.json()['filePath'].lstrip('/'))
    ws = openpyxl.load_workbook(path).active
    rows = list(ws.iter_rows(values_only=True))
    check('R5 列名和顺序固定', list(rows[0]) == ['订单日期', '订单号', '客户名', '款式', '款式中文', '定制信息', '字体', '数量', '袋子颜色', '贺卡内容'], rows[0])
    check('R5 只导出审核通过的订单', len(rows) == 2 and rows[1][1] == oid_icon_ok, rows)
    check('R5 定制信息和字体与审核结果一致，缺失的留空', rows[1][6] == font_name and (rows[1][8] in (None, '')) and (rows[1][9] in (None, '')), rows[1])

# ---------------------------------------------------------------- C7 / S5 字体缺失
fonts_all = get('/fonts').json()
missing = [f for f in fonts_all if f.get('fileMissing')]
check('S5 字体列表标出文件缺失的字体', len(missing) > 0, len(missing))
tpl_missing = post('/stamps/templates', dict(tpl_body, name=f'QA缺字体{RUN}', skus=[f'{rattle_sku}-F'],
                                             textElements=[dict(tpl_body['textElements'][0], fontFamily=missing[0]['name'], icon=None)]))
oid_font = f'QA{RUN}10'
upload([row(oid_font, f'{rattle_sku}-F', 'Personalization:Zoe')], endpoint='/rattle/upload')
fo = find_order(oid_font)[0]
check('C7 模板字体文件缺失时不静默换字体，订单提示"字体缺失"', fo['status'] == 'stamp_not_generated' and '字体' in (fo.get('processingError') or '') and missing[0]['name'] in (fo.get('processingError') or ''), fo.get('processingError'))

# 清理：去掉测试加到真实模板上的 SKU 关联
tpl975 = get('/stamps/templates/975').json()
put('/stamps/templates/975', {'skus': [sku for sku in tpl975.get('skus', []) if not sku.startswith('EB-K31-ZD-QA')]})

passed = sum(1 for _, ok, _ in results if ok)
print(f'\n{passed} passed, {len(results) - passed} failed')
sys.exit(0 if passed == len(results) else 1)
