#!/usr/bin/env python3
"""Fixtures only in the isolated Thunderbird profile (port 2831). Never sends mail."""
import argparse,json,struct,zlib
from seed_feature_fixtures import message,ADA
import spark

def pdf():
    streams=[b'BT /F1 24 Tf 50 730 Td (Attachment preview check) Tj 0 -45 Td /F1 13 Tf (This PDF has two pages and is rendered locally.) Tj ET',b'BT /F1 24 Tf 50 730 Td (Second page) Tj 0 -45 Td /F1 13 Tf (Page navigation works.) Tj ET']
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',b'<< /Length '+str(len(streams[0])).encode()+b' >>\nstream\n'+streams[0]+b'\nendstream',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',b'<< /Length '+str(len(streams[1])).encode()+b' >>\nstream\n'+streams[1]+b'\nendstream',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    data=b'%PDF-1.4\n';offsets=[0]
    for index,obj in enumerate(objects,1):offsets.append(len(data));data+=f'{index} 0 obj\n'.encode()+obj+b'\nendobj\n'
    start=len(data);data+=b'xref\n0 8\n0000000000 65535 f \n'+b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets[1:])+f'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode();return data

def png():
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    width,height=320,160
    pixels=b''.join(b'\x00'+b''.join(bytes((255,255,255) if 28<y<50 and 30<x<280 or 75<y<90 and 30<x<210 else (10,102,232)) for x in range(width)) for y in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--background',type=int,default=0);parser.add_argument('--preview',action='store_true');parser.add_argument('--tag',default='');args=parser.parse_args();client=spark.connect();fixtures=[]
    if args.preview:
        mail=message('attachment-preview','Spark smoke attachment previews',ADA,'Sapphirepreview offline attachment check. Both files can be previewed locally.',0)
        mail.add_attachment(pdf(),maintype='application',subtype='pdf',filename='spark-preview.pdf');mail.add_attachment(png(),maintype='image',subtype='png',filename='spark-preview.png');fixtures.append(mail)
    for i in range(args.background):fixtures.append(message(f'background-cache-{args.tag}-{i}',f'Ember background cache check {i+1:02}',ADA if i%2==0 else 'Sophie Wilson <sophie@science.test>',f'Glacierquartzofflinecheck{args.tag} {i+1}. This body should be searchable after the Ember tab closes.',0))
    result=[]
    for mail in fixtures:
        code='''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const folder=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);const mid=%s;if(folder.msgDatabase.getMsgHdrForMessageID(mid))return {existing:mid};const header=folder.addMessage(%s);return {added:mid,key:header.messageKey};'''%(json.dumps(str(mail['Message-ID']).strip('<>')),json.dumps(mail.as_string()))
        result.append(client.execute(code))
    print(json.dumps({'added':sum('added' in r for r in result),'existing':sum('existing' in r for r in result)},indent=2))
if __name__=='__main__':main()
