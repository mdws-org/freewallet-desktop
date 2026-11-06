/*
 * Wallet backup export/import dialogs. The file format and all checks are in
 * wallet-backup.js; this file holds the dialogs and the one place that talks to
 * the shell's file save/open (BackupFileIO).
 */

// File save/open for the shell the page runs in. NW.js gets a native save
// dialog through <input nwsaveas> and writes with Node's fs; a plain browser
// (and a later non-NW shell until it supplies its own calls) gets a download.
// Opening uses a file input and FileReader, which work everywhere.
var BackupFileIO = {
    isNW: function(){
        return typeof nw !== 'undefined' && typeof require === 'function';
    },
    _input: function(attrs, onChange){
        var input = $('<input type="file" style="display:none">').attr(attrs);
        input.on('change', function(){
            var el = this;
            onChange(el);
            input.remove();
        });
        $('body').append(input);
        input.trigger('click');
    },
    // done(err, where) runs after the file is written; it does not run if the
    // user cancels the save dialog.
    save: function(filename, text, done){
        if(BackupFileIO.isNW()){
            BackupFileIO._input({ nwsaveas: filename, accept: '.json' }, function(el){
                var path = el.value;
                if(!path) return;
                try {
                    require('fs').writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
                    done(null, path);
                } catch(e){
                    done(e);
                }
            });
        } else {
            var url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
                a   = $('<a style="display:none"></a>').attr({ href: url, download: filename });
            $('body').append(a);
            a[0].click();
            a.remove();
            setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
            done(null, filename);
        }
    },
    // done(err, text, name) runs once a file has been chosen and read.
    open: function(done){
        BackupFileIO._input({ accept: '.json,application/json' }, function(el){
            var file = el.files && el.files[0];
            if(!file) return;
            if(file.size > WalletBackup.MAX_FILE_BYTES)
                return done(new Error('This file is too large to be a FreeWallet backup'));
            var reader = new FileReader();
            reader.onload  = function(){ done(null, String(reader.result), file.name); };
            reader.onerror = function(){ done(new Error('The file could not be read')); };
            reader.readAsText(file);
        });
    }
};

function backupAppVersion(){
    try {
        return (typeof nw !== 'undefined' && nw.App && nw.App.manifest) ? String(nw.App.manifest.version) : 'web';
    } catch(e){
        return 'web';
    }
}

function backupPasswordInput(name, placeholder, style){
    return '<input name="' + name + '" type="text" class="form-control" placeholder="' + placeholder + '" autocomplete="off" style="' + (style || '') + '-webkit-text-security: disc;"/>';
}

// 'Export Wallet Backup' dialog box
function dialogExportBackup(){
    if(dialogCheckLocked('export a wallet backup'))
        return;
    if(readVault()===null){
        dialogMessage(null, 'There is no wallet record on this device to back up.', true);
        return;
    }
    BootstrapDialog.show({
        type: 'type-default',
        title: '<i class="fa fa-lg fa-fw fa-download"></i> Export Wallet Backup',
        cssClass: 'btc-wallet-password',
        closeByBackdrop: false,
        message: function(dialog){
            var msg = $('<div></div>');
            msg.append('<p class="justify">The backup file holds your wallet, still encrypted with your wallet password, inside a second layer of encryption under the backup password you choose here. It also holds your address labels and wallet settings. Your passphrase is not written to the file in readable form.</p>');
            msg.append(backupPasswordInput('backup_password', 'Backup Password', 'margin-bottom: 10px; '));
            msg.append(backupPasswordInput('backup_confirm_password', 'Confirm Backup Password', 'margin-bottom: 10px; '));
            msg.append('<p class="justify no-bottom-margin">To restore from this file you will need the backup password and the wallet password this wallet has now. Neither can be recovered if lost; your 12-word passphrase still restores the wallet without them.</p>');
            return msg;
        },
        onshown: function(dialog){
            $('[name="backup_password"]').focus();
        },
        buttons:[{
            label: 'Cancel',
            icon: 'fa fa-lg fa-fw fa-thumbs-down',
            cssClass: 'btn-danger',
            action: function(dialog){
                dialog.close();
            }
        },{
            label: 'Export',
            icon: 'fa fa-lg fa-fw fa-thumbs-up',
            cssClass: 'btn-success',
            hotkey: 13,
            action: function(dialog){
                var pass = $('[name="backup_password"]').val(),
                    err  = validateNewWalletPassword(pass, $('[name="backup_confirm_password"]').val()),
                    text = null;
                if(err)
                    err = err.replace('Wallet password', 'Backup password');
                if(!err){
                    try {
                        text = WalletBackup.create(WalletBackup.collect(ls), pass, { app: backupAppVersion() });
                    } catch(e){
                        err = 'The backup could not be created: ' + e.message;
                    }
                }
                if(err){
                    backupError(err);
                    return;
                }
                dialog.close();
                BackupFileIO.save(WalletBackup.fileName(), text, function(e, where){
                    if(e)
                        backupError('The backup file could not be saved: ' + e.message);
                    else
                        dialogMessage('<i class="fa fa-lg fa-fw fa-download"></i> Backup saved', $('<p></p>').text('Your wallet backup was saved to ' + where + '.'));
                });
            }
        }]
    });
}

// Error dialog for messages that can carry text from a backup file or an
// exception. dialogMessage renders a string as HTML, so the text goes in as a
// text node.
function backupError(msg){
    dialogMessage(null, $('<p></p>').text(String(msg)), true);
}

// 'Import Wallet Backup': choose a file, then ask for its password.
function dialogImportBackup(){
    BackupFileIO.open(function(e, text, name){
        if(e){
            backupError(e.message);
            return;
        }
        var h = WalletBackup.readHeader(text);
        if(!h.ok){
            backupError(h.message);
            return;
        }
        dialogImportBackupPassword(text, name, h.header);
    });
}

function dialogImportBackupPassword(text, name, header){
    BootstrapDialog.show({
        type: 'type-default',
        title: '<i class="fa fa-lg fa-fw fa-upload"></i> Import Wallet Backup',
        cssClass: 'btc-wallet-password',
        closeByBackdrop: false,
        message: function(dialog){
            var msg = $('<div></div>');
            msg.append($('<p class="justify"></p>').text('File: ' + name + (header.created ? ' (created ' + header.created + ')' : '')));
            msg.append(backupPasswordInput('backup_password', 'Backup Password', 'margin-bottom: 10px; '));
            msg.append('<p class="justify no-bottom-margin">After the import, unlock the wallet with the wallet password it had when the backup was made.</p>');
            return msg;
        },
        onshown: function(dialog){
            $('[name="backup_password"]').focus();
        },
        buttons:[{
            label: 'Cancel',
            icon: 'fa fa-lg fa-fw fa-thumbs-down',
            cssClass: 'btn-danger',
            action: function(dialog){
                dialog.close();
            }
        },{
            label: 'Import',
            icon: 'fa fa-lg fa-fw fa-thumbs-up',
            cssClass: 'btn-success',
            hotkey: 13,
            action: function(dialog){
                var res = WalletBackup.open(text, $('[name="backup_password"]').val());
                if(!res.ok){
                    backupError(res.message);
                    return;
                }
                dialog.close();
                if(WalletBackup.hasWallet(ls))
                    dialogConfirmReplaceWallet(res.entries);
                else
                    importBackupEntries(res.entries);
            }
        }]
    });
}

// An existing wallet is never replaced without this confirmation, which names
// the stored entries the import removes or overwrites.
function dialogConfirmReplaceWallet(entries){
    var replaced = WalletBackup.replacedKeys(ls, entries),
        current  = ls.getItem('walletAddress'),
        incoming = entries.walletAddress || null;
    BootstrapDialog.show({
        type: 'type-default',
        closeByBackdrop: false,
        cssClass: 'dialog-logout',
        title: '<i class="fa fa-lg fa-fw fa-exclamation-triangle"></i> Replace the wallet on this device?',
        message: function(dialog){
            var msg  = $('<div></div>'),
                list = $('<ul></ul>');
            msg.append('<p>This device already has a wallet. Importing the backup removes it and puts the backup\'s wallet in its place.</p>');
            if(current)
                msg.append($('<p></p>').text('Current address: ' + current));
            if(incoming)
                msg.append($('<p></p>').text('Address in the backup: ' + incoming));
            msg.append('<p>These stored entries will be replaced or removed:</p>');
            replaced.forEach(function(k){ list.append($('<li></li>').text(k)); });
            msg.append(list);
            msg.append('<div class="alert alert-danger fade in center bold">Make sure the current wallet\'s 12-word passphrase is written down before you continue.</div>');
            msg.append('<div class="checkbox" id="dialog-import-confirm"><label><input type="checkbox" id="dialog-import-confirm-checkbox"> I have <u>written down</u> or otherwise <u>securely stored</u> the current wallet\'s passphrase.</label></div>');
            return msg;
        },
        buttons:[{
            label: 'No',
            icon: 'fa fa-lg fa-fw fa-thumbs-down',
            cssClass: 'btn-danger',
            action: function(dialog){
                dialog.close();
            }
        },{
            label: 'Replace',
            icon: 'fa fa-lg fa-fw fa-thumbs-up',
            cssClass: 'btn-success',
            action: function(dialog){
                if(!$('#dialog-import-confirm-checkbox').is(':checked')){
                    $('#dialog-import-confirm').effect('shake', { times: 3, direction: 'up' }, 1000);
                    return;
                }
                dialog.close();
                importBackupEntries(entries);
            }
        }]
    });
}

// Write the backup's entries, drop every session copy of the old wallet, and
// reload so the app starts from the restored records (locked).
function importBackupEntries(entries){
    try {
        WalletBackup.apply(ls, entries);
    } catch(e){
        backupError('The backup could not be written, and the wallet on this device was left as it was: ' + e.message);
        return;
    }
    ['wallet', 'walletPassword', 'btcpayWallet', 'btcpayKeys', 'skipWalletAuth'].forEach(function(k){ ss.removeItem(k); });
    FW.WALLET_ENCKEY = null;
    FW.WALLET_KEYS = {};
    dialogMessage('<i class="fa fa-lg fa-fw fa-upload"></i> Backup imported', 'The wallet from the backup is now on this device. FreeWallet will reload; unlock it with its wallet password.', false, false, function(){
        window.location.reload();
    });
}
