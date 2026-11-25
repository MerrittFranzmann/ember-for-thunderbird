#!/usr/bin/env python3
"""Exercise real Ember sending only in the isolated fixture profile, via a local SMTP sink.
Never connects to an external SMTP service. Fixture mail has no real recipients.
"""
import argparse,email,json,queue,socketserver,sys,threading,time
from pathlib import Path
import spark

class Sink(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b'220 localhost Ember test SMTP\r\n')
        while True:
            line=self.rfile.readline()
            if not line:return
            command=line.decode(errors='replace').split(' ',1)[0].strip().upper()
            if command in ('EHLO','HELO'):self.wfile.write(b'250-localhost\r\n250 SIZE 10485760\r\n')
            elif command in ('MAIL','RCPT','RSET','NOOP'):self.wfile.write(b'250 OK\r\n')
            elif command=='DATA':
                self.wfile.write(b'354 End with dot\r\n');chunks=[]
                while True:
                    part=self.rfile.readline()
                    if part in (b'.\r\n',b''):break
                    chunks.append(part[1:] if part.startswith(b'..') else part)
                self.server.messages.put(b''.join(chunks));time.sleep(.4);self.wfile.write(b'250 Accepted\r\n')
            elif command=='QUIT':self.wfile.write(b'221 Bye\r\n');return
            else:self.wfile.write(b'250 OK\r\n')

parser=argparse.ArgumentParser();parser.add_argument('--output-dir',type=Path,required=True);parser.add_argument('--cases',default='');args=parser.parse_args();args.output_dir.mkdir(parents=True,exist_ok=True)
server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Sink);server.daemon_threads=True;server.messages=queue.Queue();threading.Thread(target=server.serve_forever,daemon=True).start()
m=spark.connect()
config=m.execute('''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const smtp=MailServices.outgoingServer.createServer("smtp").QueryInterface(Ci.nsISmtpServer);smtp.hostname='127.0.0.1';smtp.port=%d;smtp.authMethod=Ci.nsMsgAuthMethod.none;smtp.socketType=Ci.nsMsgSocketType.plain;smtp.description='Ember local SMTP test';const identity=MailServices.accounts.createIdentity();identity.email='sender@spark.test';identity.fullName='Ember Loopback';identity.smtpServerKey=smtp.key;identity.doFcc=false;identity.composeHtml=true;const account=MailServices.accounts.getAccount('account2');account.addIdentity(identity);window.__sparkSendFixture={identity:identity.key,smtp:smtp.key,account:account.key,progress:Services.prefs.getBoolPref('mailnews.show_send_progress',true),windows:[]};const observer={onOpenWindow(win){const w=win.docShell.domWindow;w.addEventListener('load',()=>window.__sparkSendFixture.windows.push({url:w.document.documentURI,type:w.document.documentElement.getAttribute('windowtype'),state:w.windowState}),{once:true});},onCloseWindow(){}};window.__sparkSendFixture.observer=observer;Services.wm.addListener(observer);return {identity:identity.key,smtp:smtp.key};'''%server.server_address[1])
try:
    print(spark.chrome_async(m,"const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');await ExtensionPermissions.add('thunderbird-spark@merrittfranzmann',{permissions:['messages.send'],origins:[]});return true;"),flush=True)
    spark.chrome_async(m,"const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await (await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann')).reload();return true;")
    time.sleep(3)  # the reload closes Ember's window; let the add-on restart before reopening it
    m.execute("const tm=document.getElementById('tabmail');const url=WebExtensionPolicy.getByID('thunderbird-spark@merrittfranzmann').getURL('app.html');const t=tm.tabInfo.find(t=>(t.browser||t.chromeBrowser)?.currentURI?.spec===url);if(t)(t.browser||t.chromeBrowser).reload();else tm.openTab('contentTab',{url});return true;")
    time.sleep(8)
    ready=spark.run_in_app(m,"for(let i=0;i<400;i++){if(document.querySelector('.sidebar .item')&&!document.querySelector('.mini-spin'))return {send:typeof messenger.messages.sendMessage,version:messenger.runtime.getManifest().version};await new Promise(r=>setTimeout(r,50));}throw new Error('Startup timeout');")
    assert isinstance(ready,dict) and ready['send']=='function',ready
    print('Ready',ready,flush=True)
    spark.run_in_app(m,"await messenger.storage.local.set({undoSend:0});await new Promise(r=>setTimeout(r,300));return true;")  # sends right away (tools/test_outbox.py covers the delay)
    results=[]
    CASES=[('reply-with-progress','reply',True),('background-new','new',False),('reply-no-progress','reply',False),('forward-no-progress','forward',False),('reply-draft','draft',False)]
    if args.cases: CASES=[c for c in CASES if c[0] in args.cases.split(',')]
    for case,kind,progress in CASES:
        m.execute('window.__sparkSendFixture.windows=[];Services.prefs.setBoolPref("mailnews.show_send_progress",'+json.dumps(progress)+');return true;')
        if kind=='new':spark.run_in_app(m,"window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));return true;")
        elif kind=='draft':
            # A reply draft (as an agent's draft_reply or Thunderbird saves one), opened from Ember's Drafts and sent.
            r=spark.run_in_app(m,"""const pause=ms=>new Promise(r=>setTimeout(r,ms));
let page=await messenger.messages.query({subject:'Spark smoke quoted history'});const all=[...page.messages];while(page.id){page=await messenger.messages.continueList(page.id);all.push(...page.messages);}
const orig=all.filter(x=>x.headerMessageId==='history-latest@spark-smoke.test'||x.headerMessageId==='<history-latest@spark-smoke.test>')[0]||all.filter(x=>!x.folder?.specialUse?.some(u=>u==='sent'||u==='drafts'))[0];
if(!orig)throw new Error('no original: '+JSON.stringify(all.map(x=>[x.folder?.name,x.headerMessageId])));
const stale=all.filter(x=>x.folder?.specialUse?.includes('drafts')).map(x=>x.id);if(stale.length)await messenger.messages.delete(stale,true);// earlier runs' drafts, so the row opened below is this run's
const tab=await messenger.compose.beginReply(orig.id,'replyToSender',{identityId:%s,body:'<p>Draft text</p>'});await messenger.windows.update(tab.windowId,{state:'minimized'});
const saved=await messenger.compose.saveMessage(tab.id,{mode:'draft'});await messenger.compose.setComposeDetails(tab.id,{isModified:false}).catch(()=>{});await messenger.tabs.remove(tab.id);
window.__draftId=saved.messages[0].headerMessageId;
[...document.querySelectorAll('.sidebar .item.parent')].find(b=>b.getAttribute('aria-label')?.startsWith('Drafts'))?.click();
return true;"""%json.dumps(config['identity']));assert r is True,r
            # Its row (only this run's draft: the earlier ones were just deleted), polled here: listing a new draft can
            # take several seconds, past one Marionette script's 30 s.
            for _ in range(120):
                if spark.run_in_app(m,"const rows=[...document.querySelectorAll('.row')].filter(r=>r.querySelector('.subject')?.textContent.includes('Spark smoke quoted history'));if(rows.length===1){rows[0].click();return true;}return false;") is True:break
                time.sleep(.5)
            else:raise AssertionError('Draft row missing')
            m.execute('window.__sparkSendFixture.windows=[];return true;')  # the composer that saved the draft (setup) isn't Ember's
        else:
            subject='Spark smoke attachment previews' if kind=='forward' else 'Spark smoke quoted history'
            body="""const pause=ms=>new Promise(r=>setTimeout(r,ms));const wait=async fn=>{for(let n=0;n<400;n++){if(fn())return;await pause(50);}throw new Error('Conversation timeout');};window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true,cancelable:true}));await pause(200);const input=document.querySelector('.search input');input.value=%s;input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));let seen=null;await wait(()=>{if(document.querySelector('.mini-spin'))return false;const row=[...document.querySelectorAll('.row')].find(r=>r.querySelector('.subject')?.textContent===%s);if(row&&row===seen){row.click();return true;}seen=row||null;return false;});/* %s: click the row once it stays put, in the check that finds it (results arrive twice) */await wait(()=>document.querySelector('.thread')?.dataset.relatedBusy==='false');[...document.querySelectorAll('.reader .reply-bar button[data-action="%s"]')].pop().click();return true;"""%(json.dumps(subject),json.dumps(subject),json.dumps(subject),'forward' if kind=='forward' else 'reply')
            r=spark.run_in_app(m,body);assert r is True,r
        fill="""for(let n=0;n<400&&!document.querySelector('.sheet');n++)await new Promise(r=>setTimeout(r,50));const sheet=document.querySelector('.sheet');if(!sheet)throw new Error('Composer missing');sheet.querySelector('#c-from').click();await new Promise(r=>setTimeout(r,50));sheet.querySelector('[data-identity="'+%s+'"]').click();await new Promise(r=>setTimeout(r,80));const input=sheet.querySelector('#c-to');if(%s){input.value='recipient@spark.test';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));}const subject=sheet.querySelector('#c-subj');if(%s){subject.value='Ember loopback new mail';subject.dispatchEvent(new Event('input',{bubbles:true}));}const editor=sheet.querySelector('[contenteditable=true]');editor.innerHTML='<p>Loopback fixture body.</p>';editor.dispatchEvent(new Event('input',{bubbles:true}));return {to:sheet.querySelector('.chip-name')?.textContent,subject:subject.value};"""%(json.dumps(config['identity']),json.dumps(kind in ('new','forward')),json.dumps(kind=='new'))
        r=spark.run_in_app(m,fill);assert isinstance(r,dict),r
        spark.run_in_app(m,"document.querySelector('.sheet .send').click();return true;")
        states=[]
        until=time.time()+30
        while time.time()<until:
            status=spark.run_in_app(m,"return {open:!!document.querySelector('.sheet'),error:document.querySelector('.sheet .error')?.textContent};")
            states+=m.execute("return [...Services.wm.getEnumerator('msgcompose')].map(w=>w.windowState);") or []
            if status.get('error'):raise RuntimeError(case+': '+status['error'])
            if not status['open']:break
            time.sleep(.05)
        assert not status['open'],status
        raw=server.messages.get(timeout=3);mail=email.message_from_bytes(raw)
        windows=m.execute('return window.__sparkSendFixture.windows;')
        record={'case':case,'windows':windows,'minimizedObserved':2 in states,'subject':str(mail['Subject']),'references':str(mail.get('References','')),'inReplyTo':str(mail.get('In-Reply-To','')),'attachments':[p.get_filename() for p in mail.walk() if p.get_filename()],'bytes':len(raw)}
        assert any('Loopback fixture body' in (p.get_payload(decode=True) or b'').decode(errors='replace') for p in mail.walk() if not p.is_multipart())
        if kind=='new':assert not windows,windows
        if kind in ('reply','draft'):assert 'history-root@spark-smoke.test' in record['references'] and record['inReplyTo'],record  # in the thread (its latest message can be an earlier run's reply)
        if kind=='draft':assert record['subject'].startswith('Re: ') and 'history-latest@spark-smoke.test' in record['inReplyTo'],record
        if kind=='forward':assert 'spark-preview.pdf' in record['attachments'],record
        if not progress:assert not any('sendProgress' in w['url'] for w in windows),windows
        # Replies and reply drafts go without Thunderbird's composer (sparkSend, 0.1.116); a forward with
        # attachments still uses it, minimized.
        if kind in ('reply','draft'):assert not any(w.get('type')=='msgcompose' for w in windows) and not record['minimizedObserved'],record
        if kind=='forward':assert record['minimizedObserved'],record
        if kind=='reply':
            record['originalReplied']=m._cmd("WebDriver:ExecuteScript",{"script":"const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');for(const f of MailServices.accounts.allFolders){try{const h=f.msgDatabase.getMsgHdrForMessageID('history-latest@spark-smoke.test');if(h&&!f.isSpecialFolder(Ci.nsMsgFolderFlags.SentMail,true))return !!(h.flags&Ci.nsMsgMessageFlags.Replied);}catch{}}return null;","args":[]})['value']
            assert record['originalReplied'] is True,record
        results.append(record);print(json.dumps(record),flush=True)
    (args.output_dir/'send-flow.json').write_text(json.dumps({'app':ready,'transport':'127.0.0.1 only; no external deliveries','cases':results},indent=2)+'\n')
finally:
    try:m.execute("const f=window.__sparkSendFixture;if(f){Services.wm.removeListener(f.observer);Services.prefs.setBoolPref('mailnews.show_send_progress',f.progress);const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const identity=MailServices.accounts.getIdentity(f.identity);MailServices.accounts.getAccount(f.account).removeIdentity(identity);const smtp=MailServices.outgoingServer.getServerByKey(f.smtp);MailServices.outgoingServer.deleteServer(smtp);delete window.__sparkSendFixture;}return true;")
    finally:server.shutdown();server.server_close()
